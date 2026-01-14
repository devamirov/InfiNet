/**
 * PWA Install Banner - React-like modular implementation
 * Follows standard PWA patterns like uncensored.chat
 */
(function() {
    'use strict';
    
    // Banner State Management (React-like state)
    const BannerState = {
        dismissed: false,
        installed: false,
        promptAvailable: false,
        deferredPrompt: null
    };

    // Banner Configuration
    const Config = {
        bannerId: 'pwa-install-banner',
        installBtnId: 'pwa-install-btn',
        dismissBtnId: 'pwa-dismiss-btn',
        storageKey: 'pwa-banner-dismissed-session',
        showDelay: 1000
    };

    // Utility Functions
    const Utils = {
        getElement: (id) => document.getElementById(id),
        getStorage: (key) => sessionStorage.getItem(key),
        setStorage: (key, value) => sessionStorage.setItem(key, value),
        removeStorage: (key) => sessionStorage.removeItem(key),
        isStandalone: () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
        getManifestUrl: async () => {
            const link = document.querySelector('link[rel="manifest"]');
            if (!link) return null;
            try {
                const manifest = await fetch(link.href).then(r => r.json());
                const startUrl = manifest.start_url || '/';
                return startUrl.startsWith('http') ? startUrl : window.location.origin + startUrl;
            } catch (e) {
                return window.location.origin;
            }
        }
    };

    // Banner Component (React-like)
    const Banner = {
        element: null,
        installBtn: null,
        dismissBtn: null,

        init() {
            this.element = Utils.getElement(Config.bannerId);
            this.installBtn = Utils.getElement(Config.installBtnId);
            this.dismissBtn = Utils.getElement(Config.dismissBtnId);
            
            if (!this.element) {
                console.warn('[PWA Banner] Element not found:', Config.bannerId);
                return false;
            }
            console.log('[PWA Banner] Initialized successfully');
            return true;
        },

        show() {
            if (!this.element) {
                console.warn('[PWA Banner] Cannot show: element not found');
                return false;
            }
            if (BannerState.dismissed) {
                console.log('[PWA Banner] Cannot show: dismissed');
                return false;
            }
            if (BannerState.installed) {
                console.log('[PWA Banner] Cannot show: already installed');
                return false;
            }
            this.element.classList.add('show');
            console.log('[PWA Banner] Showing banner');
            return true;
        },

        hide() {
            if (this.element) {
                this.element.classList.remove('show');
            }
        }
    };

    // Install Handler (React-like action handler)
    const InstallHandler = {
        async handleInstall() {
            // Chrome/Android: Try install prompt
            if (BannerState.deferredPrompt) {
                try {
                    await BannerState.deferredPrompt.prompt();
                    const result = await BannerState.deferredPrompt.userChoice;
                    BannerState.deferredPrompt = null;
                    window.deferredPrompt = null;
                    Banner.hide();
                    return result.outcome === 'accepted';
                } catch (e) {
                    console.error('[PWA Banner] Prompt error:', e);
                }
            }

            // Safari/iOS or fallback: Show install instructions modal instead of redirecting
            // (redirecting to same page just refreshes, which is useless)
            const modal = Utils.getElement('install-instructions-modal');
            if (modal) {
                modal.classList.add('show');
                Banner.hide();
                console.log('[PWA Banner] Showing install instructions modal');
            } else {
                console.warn('[PWA Banner] Install modal not found');
            }
            return false;
        }
    };

    // Banner Controller (React-like component controller)
    const BannerController = {
        shouldShow() {
            if (BannerState.dismissed) {
                console.log('[PWA Banner] shouldShow: false (dismissed)');
                return false;
            }
            if (BannerState.installed) {
                console.log('[PWA Banner] shouldShow: false (installed)');
                return false;
            }
            if (Utils.isStandalone()) {
                console.log('[PWA Banner] shouldShow: false (standalone mode)');
                return false;
            }
            if (Utils.getStorage(Config.storageKey) === 'true') {
                console.log('[PWA Banner] shouldShow: false (dismissed in session)');
                return false;
            }
            console.log('[PWA Banner] shouldShow: true');
            return true;
        },

        async initialize() {
            if (!Banner.init()) return;

            // Setup event listeners
            if (Banner.installBtn) {
                Banner.installBtn.addEventListener('click', () => InstallHandler.handleInstall());
            }

            if (Banner.dismissBtn) {
                Banner.dismissBtn.addEventListener('click', () => {
                    Utils.setStorage(Config.storageKey, 'true');
                    BannerState.dismissed = true;
                    Banner.hide();
                });
            }

            // Listen for install prompt
            window.addEventListener('beforeinstallprompt', (e) => {
                e.preventDefault();
                BannerState.deferredPrompt = e;
                BannerState.promptAvailable = true;
                window.deferredPrompt = e;
                
                if (this.shouldShow()) {
                    setTimeout(() => Banner.show(), Config.showDelay);
                }
            });

            // Listen for app installed
            window.addEventListener('appinstalled', () => {
                BannerState.installed = true;
                BannerState.deferredPrompt = null;
                window.deferredPrompt = null;
                Banner.hide();
            });

            // Initial show attempt - show banner even without install prompt (for Safari)
            console.log('[PWA Banner] Checking if should show...');
            if (this.shouldShow()) {
                console.log('[PWA Banner] Will show banner in', Config.showDelay, 'ms');
                setTimeout(() => {
                    // Show banner regardless of prompt availability (works for Safari redirect)
                    const shown = Banner.show();
                    if (!shown) {
                        console.warn('[PWA Banner] Failed to show banner');
                    }
                }, Config.showDelay);
            } else {
                console.log('[PWA Banner] Banner will not show (shouldShow returned false)');
            }
        }
    };

    // Initialize when DOM is ready
    console.log('[PWA Banner] Script loaded, document.readyState:', document.readyState);
    if (document.readyState === 'loading') {
        console.log('[PWA Banner] Waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', () => {
            console.log('[PWA Banner] DOMContentLoaded fired');
            BannerController.initialize();
        });
    } else {
        console.log('[PWA Banner] DOM already ready, initializing immediately');
        BannerController.initialize();
    }

    // Expose for testing
    window.PWABanner = {
        show: () => {
            Utils.removeStorage(Config.storageKey);
            BannerState.dismissed = false;
            return Banner.show();
        },
        hide: () => Banner.hide(),
        state: BannerState
    };
})();

