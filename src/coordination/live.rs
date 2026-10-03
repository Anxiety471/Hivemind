//! Live channel into running attempts. Hivemind carries every message;
//! runtimes never talk to each other.
//!
//! - Steering: a user steer, a message to a persona that is mid-attempt, or an
//!   accepted decision is pushed into the running session (Pi/OMP `steer`:
//!   after the current tool calls, before the next model call). Steering is
//!   only a fast path: every steered text is also recorded durably (task
//!   feedback, the recipient's inbox, the decision log).
//! - Questions: `tasks.ask` keeps the attempt running while it waits for an
//!   answer from the user (`tasks/{id}/input`) or from the persona it asked (a
//!   message whose `causation` is the question), bounded by
//!   `question_timeout_secs` and `max_questions`.
use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::oneshot;

use super::{
    model::*,
    service::{CoordinationService, SendMessage, ToolCtx},
};
use crate::identity::AgentInstanceId;

/// Pushes text into the live session of one agent instance; `false` means
/// there is no live session to take it.
pub type Steerer = Arc<dyn Fn(&AgentInstanceId, &str) -> bool + Send + Sync>;

#[derive(Default)]
pub(super) struct LiveChannel {
    steerer: parking_lot::RwLock<Option<Steerer>>,
    questions: Mutex<HashMap<String, Pending>>,
    asked: Mutex<HashMap<String, u32>>,
}

struct Pending {
    task_id: String,
    root_id: String,
    persona: String,
    question: String,
    to: Option<String>,
    message_id: Option<String>,
    asked_at: i64,
    answer: oneshot::Sender<Answer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub from: String,
    pub text: String,
}

/// A question a running attempt is waiting on.
#[derive(Debug, Clone, Serialize)]
pub struct OpenQuestion {
    pub attempt_id: String,
    pub persona: String,
    pub question: String,
    pub to: Option<String>,
    pub message_id: Option<String>,
    pub asked_at: i64,
}

/// Where a steer landed.
#[derive(Debug, Clone, Serialize)]
pub struct SteerOutcome {
    /// Personas whose live session took the text now.
    pub delivered_to: Vec<String>,
}

fn instance(attempt: &Attempt) -> AgentInstanceId {
    AgentInstanceId::new(task_room(&attempt.task_id), &attempt.persona)
}

impl CoordinationService {
    /// Route steering to the runtime pool (the core sets this; tests replace it).
    pub fn set_steerer(&self, steerer: Steerer) {
        *self.channel().steerer.write() = Some(steerer);
    }

    fn steer_attempt(&self, attempt: &Attempt, text: &str) -> bool {
        let steerer = self.channel().steerer.read().clone();
        steerer.is_some_and(|steer| steer(&instance(attempt), text))
    }

    /// Steer `text` into every running attempt of `persona` under `root`.
    fn steer_persona(&self, root: &str, persona: &str, text: &str) -> bool {
        let attempts = self
            .store()
            .read(|db| {
                let mut out = Vec::new();
                for attempt in db.running_attempts(None)? {
                    if attempt.persona == persona
                        && db.task_or_err(&attempt.task_id)?.root_id == root
                    {
                        out.push(attempt);
                    }
                }
                Ok(out)
            })
            .unwrap_or_default();
        // Every attempt gets it; no short-circuit.
        attempts
            .iter()
            .filter(|attempt| self.steer_attempt(attempt, text))
            .count()
            > 0
    }

    /// User steer for a running task: recorded as task feedback (so a later
    /// attempt sees it too), then pushed into each running attempt on it.
    pub fn steer_task(
        &self,
        task_id: &str,
        message: &str,
        actor: &str,
    ) -> CoordResult<SteerOutcome> {
        if !self.enabled() {
            return Err(CoordError::Disabled);
        }
        let message = check_text("message", message, 4000)?;
        let attempts = self.store().write(|db| {
            let task = db.task_or_err(task_id)?;
            let attempts = db.running_attempts(Some(task_id))?;
            if attempts.is_empty() {
                return Err(CoordError::Conflict(format!(
                    "task is {} with no running attempt; nothing to steer",
                    task.status.as_str()
                )));
            }
            db.push_feedback(task_id, &format!("{actor} steer: {message}"))?;
            db.event(
                &task.root_id,
                Some(task_id),
                actor,
                "task.steered",
                serde_json::json!({"message": message}),
            )?;
            Ok(attempts)
        })?;
        self.changed();
        let text = format!("[Hivemind: {actor} steers this task: {message}]");
        let delivered_to = attempts
            .iter()
            .filter(|a| self.steer_attempt(a, &text))
            .map(|a| a.persona.clone())
            .collect();
        Ok(SteerOutcome { delivered_to })
    }

    /// After a message commits: push it into recipients that are mid-attempt on
    /// the same root. Returns who took it live; it stays in their inbox either way.
    pub(super) fn steer_message(&self, message: &Message) -> Vec<String> {
        let text = format!(
            "[Hivemind: new {} message {} from {}: {}\nIt is also in your inbox; acknowledge it with messages.ack once handled.]",
            message.kind.as_str(),
            message.id,
            message.sender,
            clip(&message.body, 2000)
        );
        message
            .recipients
            .iter()
            .filter(|r| **r != message.sender && self.steer_persona(&message.root_id, r, &text))
            .cloned()
            .collect()
    }

    /// After a decision is accepted: tell every other persona working under the root.
    pub(super) fn steer_decision(&self, root: &str, decider: &str, decision: &Decision) {
        let text = format!(
            "[Hivemind: decision {} on task {} was accepted by {decider}: {}]",
            decision.id,
            decision.task_id,
            clip(&decision.text, 2000)
        );
        let personas: Vec<String> = self
            .store()
            .read(|db| {
                let mut out = Vec::new();
                for attempt in db.running_attempts(None)? {
                    if attempt.persona != decider
                        && !out.contains(&attempt.persona)
                        && db.task_or_err(&attempt.task_id)?.root_id == root
                    {
                        out.push(attempt.persona);
                    }
                }
                Ok(out)
            })
            .unwrap_or_default();
        for persona in personas {
            self.steer_persona(root, &persona, &text);
        }
    }

    /// Register a blocking question for this attempt. With `to`, the question
    /// is also sent to that persona as a request; its reply (a message with
    /// `causation` set to the question's message id) answers it.
    pub fn ask(
        &self,
        ctx: &ToolCtx,
        question: &str,
        to: Option<String>,
    ) -> CoordResult<(oneshot::Receiver<Answer>, Option<String>)> {
        let task = self.live(ctx)?;
        let question = check_text("question", question, 2000)?;
        let limit = self.config().max_questions;
        {
            let asked = self.channel().asked.lock();
            if asked.get(&ctx.attempt_id).copied().unwrap_or(0) >= limit {
                return Err(CoordError::Invalid(format!("question limit reached ({limit} per attempt); decide yourself or call tasks.block")));
            }
        }
        if self
            .channel()
            .questions
            .lock()
            .contains_key(&ctx.attempt_id)
        {
            return Err(CoordError::Conflict(
                "this attempt already has an open question".into(),
            ));
        }
        let message_id = match &to {
            Some(persona) => {
                let body = format!("Question from {} on task {} (they are waiting; answer with messages.send kind status, causation set to this message's id): {question}", ctx.persona, task.id);
                let (message, _) = self.send_message(
                    ctx,
                    SendMessage {
                        recipients: vec![persona.clone()],
                        task: None,
                        group: None,
                        kind: MessageKind::Request,
                        body,
                        artifacts: Vec::new(),
                        causation: None,
                        idempotency_key: None,
                    },
                )?;
                Some(message.id)
            }
            None => None,
        };
        let (tx, rx) = oneshot::channel();
        self.channel().questions.lock().insert(
            ctx.attempt_id.clone(),
            Pending {
                task_id: task.id.clone(),
                root_id: task.root_id.clone(),
                persona: ctx.persona.clone(),
                question: question.clone(),
                to: to.clone(),
                message_id: message_id.clone(),
                asked_at: self.store().now(),
                answer: tx,
            },
        );
        *self
            .channel()
            .asked
            .lock()
            .entry(ctx.attempt_id.clone())
            .or_default() += 1;
        self.store().write(|db| {
            db.event(
                &task.root_id,
                Some(&task.id),
                &ctx.persona,
                "task.question",
                serde_json::json!({"question": question, "to": to, "message_id": message_id}),
            )
            .map(|_| ())
        })?;
        self.changed();
        Ok((rx, message_id))
    }

    /// The question timed out or its attempt ended: stop waiting for it.
    pub fn withdraw_question(&self, attempt_id: &str) {
        if let Some(pending) = self.channel().questions.lock().remove(attempt_id) {
            let _ = self.store().write(|db| {
                db.event(
                    &pending.root_id,
                    Some(&pending.task_id),
                    &pending.persona,
                    "task.question_expired",
                    serde_json::json!({"question": pending.question}),
                )
                .map(|_| ())
            });
            self.changed();
        }
    }

    fn resolve(&self, find: impl Fn(&Pending) -> bool, from: &str, text: &str) -> bool {
        let pending = {
            let mut questions = self.channel().questions.lock();
            let Some(key) = questions
                .iter()
                .find(|(_, p)| find(p))
                .map(|(k, _)| k.clone())
            else {
                return false;
            };
            questions.remove(&key)
        };
        let Some(pending) = pending else { return false };
        let _ = self.store().write(|db| {
            db.event(
                &pending.root_id,
                Some(&pending.task_id),
                from,
                "task.answered",
                serde_json::json!({"question": pending.question, "answer": text}),
            )
            .map(|_| ())
        });
        self.changed();
        pending
            .answer
            .send(Answer {
                from: from.to_owned(),
                text: text.to_owned(),
            })
            .is_ok()
    }

    /// The user answers the open question on `task_id`, if there is one.
    pub fn answer_question(&self, task_id: &str, text: &str, actor: &str) -> bool {
        self.resolve(|p| p.task_id == task_id, actor, text)
    }

    /// A committed message answers a question when it replies to it and comes
    /// from the persona the question was sent to. The reply is consumed as the
    /// answer, so it does not also wake the asker's inbox.
    pub(super) fn answer_from_message(&self, message: &Message) -> bool {
        let Some(causation) = message.causation_id.as_deref() else {
            return false;
        };
        let asker = {
            let questions = self.channel().questions.lock();
            questions
                .values()
                .find(|p| {
                    p.message_id.as_deref() == Some(causation)
                        && p.to.as_deref() == Some(message.sender.as_str())
                })
                .map(|p| p.persona.clone())
        };
        let Some(asker) = asker else { return false };
        let answered = self.resolve(
            |p| p.message_id.as_deref() == Some(causation),
            &message.sender,
            &message.body,
        );
        if answered {
            let _ = self.store().write(|db| {
                db.set_delivery(&message.id, &asker, DeliveryState::Acknowledged)
                    .map(|_| ())
            });
        }
        answered
    }

    /// Questions running attempts on `task_id` are waiting on.
    pub fn open_questions(&self, task_id: &str) -> Vec<OpenQuestion> {
        self.channel()
            .questions
            .lock()
            .iter()
            .filter(|(_, p)| p.task_id == task_id)
            .map(|(attempt, p)| OpenQuestion {
                attempt_id: attempt.clone(),
                persona: p.persona.clone(),
                question: p.question.clone(),
                to: p.to.clone(),
                message_id: p.message_id.clone(),
                asked_at: p.asked_at,
            })
            .collect()
    }

    /// Whether an agent instance is currently waiting on an open question.
    pub fn has_open_question(&self, instance: &AgentInstanceId) -> bool {
        self.channel()
            .questions
            .lock()
            .values()
            .any(|p| task_room(&p.task_id) == instance.room_id && p.persona == instance.persona_id)
    }

    /// Drop live state for an attempt that ended.
    pub(super) fn forget_attempt(&self, attempt_id: &str) {
        self.channel().questions.lock().remove(attempt_id);
        self.channel().asked.lock().remove(attempt_id);
    }
}
