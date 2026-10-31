# CLAUDE.md

Personal project: artifacts in English.

## Before restarting the live server, check that no audio is being generated

The live server (`start-vault-reader.ps1` / `stop-vault-reader.ps1`, port 4610) may be streaming read-aloud audio to Zach's phone. A restart kills the generation mid-note and his playback with it; it happened on 29 Oct 2026. Check first:

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*tts.py*' }
```

Nothing listed → safe to restart. Test changes on a copy of `config.json` with another port (4699) instead of the live server.

## edge-tts throttles after a burst

After a burst of requests, Microsoft's service slows to about speaking speed for a while, and goes silent mid-request for up to ~20 s before carrying on. Heavy testing makes Zach's own listening slower afterwards, so test with short notes.

To measure what the phone would hear (silences = playback waiting on data), pipe a note's speech text through `scripts/tts.py` and time the stdout bytes against 6,000 B/s (48 kbit/s MP3). On 30 Oct 2026, a fully throttled 15-piece note gave 336 s of audio in 127 s with two ~1.7 s silences at the start.
