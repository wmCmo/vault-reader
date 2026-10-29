"""Text on stdin -> MP3 on stdout, streamed as Microsoft's neural voice produces it.

Usage: python tts.py <voice> [rate]   e.g. python tts.py en-US-AvaMultilingualNeural -5%
Called by server/tts.js; needs `pip install edge-tts`.

Long text is sent in ~1,000-character chunks, one request each: a single
request for a whole note stalls partway on the service side and never ends.
Each chunk gets a timeout and retries, so a stall costs seconds, not the note.
Audio goes out frame by frame, so a retry after a partial piece repeats that
piece's opening; rare, and better than holding a whole piece back.
"""
import asyncio
import os
import re
import sys
import time

import edge_tts

CHUNK = 1000
STALL = 10  # seconds without a new frame before a chunk is retried (a healthy chunk starts in 1-2 s)
TAIL = 4  # seconds of quiet after the last word that count as "finished"
ATTEMPTS = 3


def chunks(text):
    out, cur = [], ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if cur and len(cur) + len(line) > CHUNK:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n{line}" if cur else line
    if cur:
        out.append(cur)
    return out


def word_count(part):
    return sum(1 for t in part.split() if re.search(r"\w", t))


def last_word(part):
    words = re.findall(r"\w+", part)
    return words[-1].lower() if words else ""


async def next_frame(it, timeout):
    """Next frame, or None on a stall. A stalled request is abandoned, never
    cancelled: cancelling it hangs inside the websocket's own cleanup."""
    task = asyncio.ensure_future(it.__anext__())
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if not done:
        return None
    return task.result()  # raises StopAsyncIteration at the end


async def speak(part, voice, rate, out):
    # The service sometimes delivers all the audio and then never sends its
    # end-of-turn message. Word boundaries tell us when the last word has been
    # spoken; after that, a short quiet spell means the chunk is complete.
    # The last word alone isn't proof (it can appear earlier in the chunk), so it
    # only counts once nearly every word has had its boundary.
    # Audio is written the moment it arrives: when the service slows to speaking
    # speed, the phone plays along instead of waiting for the whole piece.
    written = 0
    target, heard_last = last_word(part), False
    total, heard = word_count(part), 0
    started, first = time.monotonic(), None
    stats = lambda how: {"secs": time.monotonic() - started, "first": first, "how": how, "bytes": written}
    it = edge_tts.Communicate(part, voice, rate=rate, boundary="WordBoundary").stream().__aiter__()
    while True:
        try:
            frame = await next_frame(it, TAIL if heard_last else STALL)
        except StopAsyncIteration:
            return stats("end message")
        if frame is None:
            if heard_last and written:
                return stats("quiet after last word")
            raise TimeoutError(f"stalled before the last word ({written} bytes already sent)")
        if first is None:
            first = time.monotonic() - started
        if frame["type"] == "audio":
            out.write(frame["data"])
            out.flush()
            written += len(frame["data"])
        elif frame["type"] == "WordBoundary":
            heard += 1
            if heard >= total * 0.9 and target and target in frame["text"].lower():
                heard_last = True


async def main():
    voice = sys.argv[1]
    rate = sys.argv[2] if len(sys.argv) > 2 else "+0%"
    text = sys.stdin.buffer.read().decode("utf-8")
    out = sys.stdout.buffer
    parts = chunks(text)
    for i, part in enumerate(parts, 1):
        for attempt in range(1, ATTEMPTS + 1):
            try:
                st = await speak(part, voice, rate, out)
                print(f"piece {i}/{len(parts)}: {st['secs']:.1f}s, first frame {st['first']:.1f}s, "
                      f"{len(part)} chars, ended by {st['how']}", file=sys.stderr, flush=True)
                break
            except Exception as err:  # noqa: BLE001
                print(f"piece {i}/{len(parts)} attempt {attempt}/{ATTEMPTS} failed: {err!r}", file=sys.stderr, flush=True)
                if attempt == ATTEMPTS:
                    raise
                await asyncio.sleep(2 * attempt)
    # Exit from inside the loop: asyncio.run's teardown would wait on any
    # abandoned request and hang.
    out.flush()
    os._exit(0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as err:  # noqa: BLE001
        print(f"tts failed: {err!r}", file=sys.stderr, flush=True)
    os._exit(1)
