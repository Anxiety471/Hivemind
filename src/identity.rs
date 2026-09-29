use serde::{Deserialize, Serialize};

/// The identity of one persona's runtime and private-memory instance in a room.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct AgentInstanceId {
    pub room_id: String,
    pub persona_id: String,
}

impl AgentInstanceId {
    pub fn new(room_id: impl Into<String>, persona_id: impl Into<String>) -> Self {
        Self {
            room_id: room_id.into(),
            persona_id: persona_id.into(),
        }
    }

    /// Return the versioned, unambiguous external representation of this identity.
    pub fn encode(&self) -> String {
        format!(
            "ai1:{}:{}{}:{}",
            self.room_id.len(),
            self.room_id,
            self.persona_id.len(),
            self.persona_id
        )
    }

    /// Decode the versioned length-prefixed representation.
    pub fn decode(encoded: &str) -> Option<Self> {
        fn take_field<'a>(input: &mut &'a str) -> Option<&'a str> {
            let (length, rest) = input.split_once(':')?;
            if length.is_empty() || (length.len() > 1 && length.starts_with('0')) {
                return None;
            }
            let length: usize = length.parse().ok()?;
            let value = rest.get(..length)?;
            *input = rest.get(length..)?;
            Some(value)
        }

        let mut rest = encoded.strip_prefix("ai1:")?;
        let room_id = take_field(&mut rest)?;
        let persona_id = take_field(&mut rest)?;
        if !rest.is_empty() {
            return None;
        }
        let identity = Self::new(room_id, persona_id);
        (identity.encode() == encoded).then_some(identity)
    }
}

#[cfg(test)]
mod tests {
    use super::AgentInstanceId;

    #[test]
    fn encoding_round_trips_arbitrary_identifier_text_without_collisions() {
        let pairs = [
            ("a/b", "c"),
            ("a", "b/c"),
            ("room 雪", "persona / ☃"),
            ("room with spaces", "punctuation:#?%"),
            ("same-room", "same-persona"),
        ];
        let identities: Vec<_> = pairs
            .iter()
            .map(|(room, persona)| AgentInstanceId::new(*room, *persona))
            .collect();
        let encoded: Vec<_> = identities.iter().map(AgentInstanceId::encode).collect();

        assert_ne!(encoded[0], encoded[1]);
        assert_eq!(
            encoded
                .iter()
                .map(|value| AgentInstanceId::decode(value).unwrap())
                .collect::<Vec<_>>(),
            identities
        );
        assert_ne!(
            AgentInstanceId::new("room", "persona"),
            AgentInstanceId::new("room/persona", "")
        );
    }

    #[test]
    fn decoding_rejects_invalid_or_trailing_data() {
        assert!(AgentInstanceId::decode("a1:1:a1:b").is_none());
        assert!(AgentInstanceId::decode("ai1:01:a1:b").is_none());
        assert!(AgentInstanceId::decode("ai1:1:a1:btrailing").is_none());
        assert!(AgentInstanceId::decode("ai1:2:☃1:b").is_none());
        assert!(AgentInstanceId::decode("ai1:+1:a1:b").is_none());
    }
}
