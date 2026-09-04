# Connecting Google Sheets

A bot's **Google Sheets** step adds one row per person who reaches it. Before it
can write anything, the server needs an identity of its own.

It uses a **service account** rather than signing in as you. The thing writing
the row is a server with nobody sitting in front of it — there is no one to
click "allow" when a token expires at three in the morning.

## One-off setup

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library →** search *Google Sheets API* → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Give it a name; you can skip the optional role and access steps.
4. Open the new service account → **Keys → Add key → Create new key → JSON.**
   A `.json` file downloads. Keep it — the key cannot be shown again.
5. Save that file somewhere outside the repo, then point the server at it:

   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=D:\keys\wppinbox-sheets.json
   ```

   (or paste the JSON itself into `GOOGLE_SERVICE_ACCOUNT_JSON`).
6. Restart the server. The step editor will now show the account's address,
   something like `wppinbox@your-project.iam.gserviceaccount.com`.

## The step everyone forgets

**Share the spreadsheet with that address, as an Editor** — exactly as you would
with a colleague. The service account is a separate identity; it cannot see your
sheets just because you can. Without this, every write fails with a permission
error and the flow logs it while carrying on.

## Using it

In the step, paste the spreadsheet link (the whole browser URL is fine — the id
is pulled out of it), name the tab, then press **Read the column names** to pull
row 1 and map each column to a value like `{{name}}`.

Test it from the builder's **Try it** panel first. A rehearsal shows the row it
*would* write without touching the real sheet.
