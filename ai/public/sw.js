// Service Worker to handle background streaming
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Only intercept streaming chat requests
    if (event.request.url.includes('/api/ollama/chat') && 
        event.request.method === 'POST' &&
        event.request.headers.get('accept')?.includes('text/event-stream') ||
        event.request.url.includes('/api/ollama/chat')) {
        
        event.respondWith(
            fetch(event.request).catch((error) => {
                // If fetch fails, return error to client
                return new Response(JSON.stringify({ 
                    error: 'Network error',
                    message: error.message 
                }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
    }
});

// Handle messages from clients
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

