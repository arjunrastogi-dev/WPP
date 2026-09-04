# Tappable buttons and lists: the Business API

## Why this exists

Interactive messages sent through WhatsApp Web automation are accepted, acked,
and then **silently never rendered** on the recipient's phone. There is no
error to catch, so no fallback can trigger — the send simply "succeeds" and
nothing appears. This was verified on this install: every plain-text reply
arrived, and no button or list message ever did.

Meta only delivers interactive messages for senders on the **WhatsApp Business
Cloud API**. That is what DoubleTick, Gupshup and every other BSP is actually
using — look at a DoubleTick conversation and you will see a "Business user ID"
on the contact panel.

So this app can send buttons and lists, but only for a session pointed at the
Cloud API. The bot flows, the builder and the engine are identical either way;
only the transport changes.

## What you need from Meta

1. A **Meta Business account** with a verified business.
2. At <https://developers.facebook.com/> create an app of type **Business**, and
   add the **WhatsApp** product.
3. Under *WhatsApp → API Setup* you get:
   - a **Phone number ID** (a long number, not the phone number itself)
   - a temporary access token, good for 24 hours
4. For anything beyond testing, create a **System User** in Business Settings,
   give it the `whatsapp_business_messaging` permission, and generate a
   **permanent access token**. A token that expires overnight will stop the bot
   at the worst possible moment.
5. The number must be registered to the WhatsApp Business Platform. A number
   already in use on the WhatsApp app has to be migrated, and it cannot be used
   in both places at once.

## Pointing a session at it

```
PUT /api/sessions/<name>/provider
{
  "provider": "cloud",
  "cloudPhoneId": "123456789012345",
  "cloudToken": "EAAG..."
}
```

The token is stored on the session row and never read back by the API — the
response only says whether one is present.

To go back to the browser transport:

```
PUT /api/sessions/<name>/provider
{ "provider": "web" }
```

## Receiving replies

Meta pushes inbound messages to a webhook, so the server has to be reachable
from the internet. In development, tunnel it:

```
npx localtunnel --port 3001      # or ngrok http 3001
```

Then in *WhatsApp → Configuration → Webhook*:

- **Callback URL**: `https://<your tunnel>/api/cloud/webhook`
- **Verify token**: whatever you set in `CLOUD_VERIFY_TOKEN` (default
  `change-me-verify-token` — change it)
- Subscribe to the **messages** field.

Meta sends a one-off challenge to verify the URL; the server echoes it back and
logs `[cloud] webhook verified by Meta`.

## Turning the taps on

Once a session is on `cloud`, open any menu step in the builder and set
**"Send this menu as"** to *Quick reply buttons* or *A tappable list*. The
numbered text version is still generated and sent whenever Meta rejects the
interactive one, so nobody is ever left unable to answer.

Meta's limits, enforced before sending: three reply buttons at 20 characters,
ten list rows at 24 characters, and exactly one action button per message
(`cta_url`). A call or copy-code button has no Cloud API equivalent, so those
steps send as text with the number and code written out.

## The 24-hour rule

Outside 24 hours of a person's last message, Meta only allows **approved
template messages**. A bot replying inside a live conversation is unaffected;
a campaign to people who have not written in recently is not, and will be
rejected until it goes out as an approved template.
