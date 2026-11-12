# forum-pod

React PWA for podlink. `src/app.jsx` mounts the family app
(`src/family/FamilyApp.jsx`): an invite-only feed, photo albums, and calendar.
Posts, names, and photos are encrypted on the device. The worker stores
ciphertext.

There is no AI and no cooperative in this package. Nothing here calls a model.

`src/messaging/` is the device-to-device sealing library (crypto, identity, pod
RPC). `Messenger.jsx` is not the screen `app.jsx` renders.

## Development

```bash
npm install
npm run dev
npm run build
node scripts/crypto-selftest.mjs
```
