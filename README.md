# What Was That File

Search your Google Drive by what is inside your files. A small AI model (all-MiniLM-L6-v2, 23 MB) runs inside Chrome, so there is no API cost and file contents never go to an AI server.

## Install (2 minutes)
1. Unzip this folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
3. The extension ID will be `pjlnminjmibngbdfhjjkojjhindnbhnd`. It stays the same on any computer, because the key is in manifest.json.

## Connect Drive (one time, about 5 minutes, free)
1. Google Cloud Console: create a project.
2. Enable **Google Drive API**.
3. Google Auth Platform: consent screen **External**, add your own email under **Audience → Test users**.
4. Clients: create a **Chrome Extension** client. Item ID: `pjlnminjmibngbdfhjjkojjhindnbhnd`.
5. Paste the Client ID into `manifest.json` in place of `PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com`.
6. Reload the extension on `chrome://extensions`.

## Use
Press **Ctrl+Shift+K** (Cmd+Shift+K on Mac) or click the icon. Click **Connect Google Drive** the first time. It indexes your 500 most recently edited files (Docs, Sheets, Slides, PDF, Word, Excel, text), then you can type what you remember.

## How it stays fast
- The model loads once and is warmed up before you type.
- All passage vectors sit in one array in memory. Comparing a query against 5,000 passages takes a few milliseconds.
- Indexing runs in small batches, and your query jumps the queue, so search stays quick while indexing.
- Repeat queries come from a cache. Only files whose "modified" time changed are re-read on sync.
- The timing line under the search box shows query time + scan time.

## Limits of this prototype
- Search works while the side panel is open; indexing pauses when it is closed.
- Scanned PDFs with no text layer are skipped. Old .doc/.ppt files and uploaded .pptx are not read.
- The model is English-first. Hinglish queries work less well.
- Runs on one CPU thread.
