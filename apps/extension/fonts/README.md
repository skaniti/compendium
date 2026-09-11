# Fonts

IBM Plex Sans (400/500/600) and IBM Plex Mono (400/500), latin-subset woff2
only, bundled locally so the extension makes no font requests at runtime.
Source: Google Fonts (`fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500`), latin `unicode-range` block only — see `LICENSE-IBM-Plex.txt` (SIL OFL 1.1).
To refresh: fetch that URL with a Chrome user-agent old enough to skip the variable-font response (e.g. `Chrome/60`), so each weight resolves to its own static file, then re-download the 5 `/* latin */` woff2 URLs into this folder.
