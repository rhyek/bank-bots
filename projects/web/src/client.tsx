import { startTransition } from 'react';
import { StartClient } from '@tanstack/react-start/client';
import { hydrateRoot } from 'react-dom/client';

// Custom client entry that REPLACES TanStack Start's default one. The default entry
// (node_modules/@tanstack/react-start/.../default-entry/client.tsx) wraps the app in
// <React.StrictMode>, whose dev-only double-invocation of effects/renders is noise here and
// breaks any single-shot effect. Omitting StrictMode is the whole reason this file exists.
// Hydrate the entire document with <StartClient/> inside startTransition so hydration stays
// interruptible.
startTransition(() => {
  hydrateRoot(document, <StartClient />);
});
