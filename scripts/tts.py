"""Text on stdin -> MP3 on stdout, streamed as Microsoft's neural voice produces it.

Usage: python tts.py <voice> [rate]   e.g. python tts.py en-US-AvaMultilingualNeural -5%
Called by server/tts.js; needs `pip install edge-tts`.

Long text is sent in ~400-character chunks, one request each. When the service
throttles (after a burst it streams at speaking speed), it stops each request
after about 60 seconds of audio and never ends it, so a chunk has to stay well
under a minute of speech, Japanese included.
Each chunk gets a timeout and retries, so a stall costs seconds, not the note.
A retry resumes where the stalled request stopped: the audio is constant-bitrate,
so two renders of the same text line up byte for byte in time.
The next chunk is fetched while the current one plays, so the gap between
chunks (the service takes 3-8 s to start one when throttled) isn't heard.
"""
import asyncio
import os
import re
import sys
import time

import edge_tts

CHUNK = 400
STALL = 30  # seconds without a new frame before a chunk is retried; when throttled, the service pauses up to ~20 s mid-chunk and then carries on
TAIL = 4  # seconds of quiet after the last word that count as "finished"
ATTEMPTS = 3
AHEAD = 3  # chunks generated at once: throttled, each arrives slower than speaking speed, so several run side by side


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


class Stalled(Exception):
    def __init__(self, written):
        super().__init__(f"stalled before the last word ({written} bytes already sent)")
        self.written = written


async def next_frame(it, timeout):
    """Next frame, or None on a stall. A stalled request is abandoned, never
    cancelled: cancelling it hangs inside the websocket's own cleanup."""
    task = asyncio.ensure_future(it.__anext__())
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if not done:
        return None
    return task.result()  # raises StopAsyncIteration at the end


async def speak(part, voice, rate, sink, skip=0):
    # The service sometimes delivers all the audio and then never sends its
    # end-of-turn message. Word boundaries tell us when the last word has been
    # spoken; after that, a short quiet spell means the chunk is complete.
    # The last word alone isn't proof (it can appear earlier in the chunk), so it
    # only counts once nearly every word has had its boundary.
    # Audio is passed on the moment it arrives. `skip` drops the bytes a stalled
    # earlier attempt already delivered, so a retry continues instead of repeating.
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
            raise Stalled(written)
        if first is None:
            first = time.monotonic() - started
        if frame["type"] == "audio":
            data = frame["data"]
            if written < skip:
                data = data[skip - written:]
                written = min(written + len(frame["data"]), skip)
            if data:
                sink(data)
                written += len(data)
        elif frame["type"] == "WordBoundary":
            heard += 1
            if heard >= total * 0.9 and target and target in frame["text"].lower():
                heard_last = True


class Piece:
    def __init__(self):
        self.buf = bytearray()
        self.done = False
        self.error = None
        self.changed = asyncio.Event()

    def add(self, data):
        self.buf += data
        self.changed.set()


async def render(i, n, part, voice, rate, piece, slots):
    async with slots:
        try:
            for attempt in range(1, ATTEMPTS + 1):
                try:
                    st = await speak(part, voice, rate, piece.add, skip=len(piece.buf))
                    print(f"piece {i}/{n}: {st['secs']:.1f}s, first frame {st['first']:.1f}s, "
                          f"{len(part)} chars, ended by {st['how']}", file=sys.stderr, flush=True)
                    return
                except Exception as err:  # noqa: BLE001
                    print(f"piece {i}/{n} attempt {attempt}/{ATTEMPTS} failed: {err!r}", file=sys.stderr, flush=True)
                    if attempt == ATTEMPTS:
                        raise
                    await asyncio.sleep(2 * attempt)
        except Exception as err:  # noqa: BLE001
            piece.error = err
        finally:
            piece.done = True
            piece.changed.set()


async def main():
    voice = sys.argv[1]
    rate = sys.argv[2] if len(sys.argv) > 2 else "+0%"
    text = sys.stdin.buffer.read().decode("utf-8")
    out = sys.stdout.buffer
    parts = chunks(text)
    pieces = [Piece() for _ in parts]
    # Slots are taken in order, so a chunk only starts once the one two back is done.
    slots = asyncio.Semaphore(AHEAD)
    for i, (part, piece) in enumerate(zip(parts, pieces), 1):
        asyncio.ensure_future(render(i, len(parts), part, voice, rate, piece, slots))
        await asyncio.sleep(0)
    # Play the chunks in order, each one as it arrives.
    for piece in pieces:
        sent = 0
        while True:
            piece.changed.clear()
            if len(piece.buf) > sent:
                out.write(piece.buf[sent:])
                out.flush()
                sent = len(piece.buf)
            if piece.done:
                break
            await piece.changed.wait()
        if piece.error:
            raise piece.error
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
