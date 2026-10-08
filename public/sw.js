// Service worker mínimo: necessário para o Chrome oferecer "Instalar app". Não faz cache de /api.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
