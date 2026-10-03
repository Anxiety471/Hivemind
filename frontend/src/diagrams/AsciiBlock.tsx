import { useEffect, useMemo, useRef, useState } from "react";
import { asciiFrames } from "./ascii";

/** Animates agent-provided text only; never evaluates agent JavaScript or HTML. */
export function AsciiBlock({ code, animated = false, streaming = false }: {
  code: string; animated?: boolean; streaming?: boolean;
}) {
  const frames = useMemo(() => asciiFrames(code, animated), [code, animated]);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [source, setSource] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [copyStatus, setCopyStatus] = useState("Copy");
  const pre = useRef<HTMLPreElement>(null);
  const animation = useRef<Animation | null>(null);
  const cycle = useRef(0);
  const [replay, setReplay] = useState(0);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setReduced(media.matches); if (media.matches) setPlaying(false); };
    const visibility = () => setHidden(document.hidden);
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    setPlaying(false); setFrame(0); cycle.current = 0; setSource(false);
  }, [code, animated]);

  useEffect(() => {
    if (frames.length !== 1 || streaming || reduced || source || !pre.current) return;
    const rows = Math.max(1, frames[0].split("\n").length);
    const player = pre.current.animate(
      [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0% 0)" }],
      { duration: Math.min(6000, Math.max(1200, rows * 120)), easing: `steps(${rows}, end)` },
    );
    player.pause();
    player.currentTime = Math.min(6000, Math.max(1200, rows * 120));
    animation.current = player;
    player.onfinish = () => setPlaying(false);
    return () => { player.cancel(); animation.current = null; };
  }, [frames, streaming, reduced, source, replay]);

  useEffect(() => {
    if (!playing || hidden || source || reduced || streaming) { animation.current?.pause(); return; }
    if (frames.length === 1) {
      const player = animation.current;
      if (player && Number(player.currentTime) >= Number(player.effect?.getTiming().duration)) player.currentTime = 0;
      player?.play();
      return;
    }
    const timer = window.setInterval(() => {
      cycle.current = (cycle.current + 1) % frames.length;
      setFrame(cycle.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, hidden, source, reduced, streaming, frames, replay]);

  const displayed = source || streaming ? code : frames[frame] ?? frames[0];
  const rows = Math.max(...frames.map((value) => value.split("\n").length));
  return <div className="markdown-code-block ascii-diagram">
    <div className="markdown-code-header ascii-toolbar">
      <span className="code-lang-tag">{animated ? "ASCII ANIMATION" : "ASCII"}</span>
      <div className="ascii-controls">
        <button type="button" className="code-copy-btn" disabled={streaming || reduced || source}
          onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Animate"}</button>
        <button type="button" className="code-copy-btn" disabled={streaming || reduced || source}
          onClick={() => { cycle.current = 0; setFrame(0); setReplay((v) => v + 1); setPlaying(true); }}>Replay</button>
        <button type="button" className="code-copy-btn" aria-pressed={source}
          onClick={() => { setPlaying(false); setSource(!source); }}>{source ? "View Animation" : "Source"}</button>
        <button type="button" className="code-copy-btn" aria-label="Copy code to clipboard"
          onClick={() => { navigator.clipboard.writeText(code).then(() => setCopyStatus("Copied!"), () => setCopyStatus("Copy failed")); }}>{copyStatus}</button>
      </div>
    </div>
    <pre ref={pre} data-lang={animated ? "ascii-animation" : "ascii"}
      style={source || streaming ? undefined : { minHeight: `${rows * 1.18 + 2}em` }}><code>{displayed}</code></pre>
    <div className="ascii-status">{streaming ? "Animation available when reply finishes" : reduced ? "Reduced motion enabled" : frames.length > 1 ? `${frame + 1} / ${frames.length} frames · 4 fps` : "Animate reveals the original ASCII line by line"}</div>
  </div>;
}
