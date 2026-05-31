self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // OS already labels the notification with the PWA name ('The Pit'), so the
  // title shouldn't include 'The Pit' again. Fallback title is intentionally
  // neutral for the rare case event.data isn't valid JSON.
  let data = { title: 'Update', body: 'Open the app for details' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    try { data = { title: 'Update', body: event.data.text() }; } catch {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Update', {
      body: data.body || '',
      tag: data.tag || 'the-pit',
      data: { url: data.url || '/' },
      icon: data.icon,
      badge: data.badge,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.location.origin)) {
        client.focus();
        client.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
