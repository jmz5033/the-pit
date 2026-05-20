self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'The Pit', body: 'Reminder' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    try { data = { title: 'The Pit', body: event.data.text() }; } catch {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'The Pit', {
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
