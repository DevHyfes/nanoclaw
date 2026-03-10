# Intent: Add google-chat-browser-auth step to setup STEPS map

Add one entry to the `STEPS` record in `setup/index.ts`:

```ts
'google-chat-browser-auth': () => import('./google-chat-browser-auth.js'),
```

Place it after `'whatsapp-auth'` to keep the ordering logical.

All existing entries in STEPS must be preserved exactly.
