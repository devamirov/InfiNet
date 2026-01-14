document.addEventListener("DOMContentLoaded", function () {
  const pathname = window.location.pathname;
  if (pathname === "/") {
    // Wait for the marquee elements to be loaded into the DOM
    const waitForMarquee = setInterval(() => {
      const wrapper = document.querySelector("#marquee-wrapper");
      const track = document.querySelector("#marquee-track");

      if (wrapper && track) {
        clearInterval(waitForMarquee);

        const clone = track.cloneNode(true);
        wrapper.appendChild(clone);

        let pos = 0;
        const speed = 0.5;

        function animate() {
          const height = track.offsetHeight;

          pos -= speed;
          if (Math.abs(pos) >= height) {
            pos = 0;
          }

          track.style.transform = `translateY(${pos}px)`;
          clone.style.transform = `translateY(${pos + height}px)`;

          requestAnimationFrame(animate);
        }

        animate();
      }
    }, 100);
  }

  const menu = document.querySelector("#menu-2-76ca91");
  if (menu) {
    const newItem = document.createElement("li");
    newItem.className = "menu-item menu-button-item";

    const origin = window.location.origin;
    const pathname = window.location.pathname;
    const segments = pathname.split("/").filter(Boolean);
    const basePath = segments.length > 0 ? `/${segments[0]}` : "";
    const contactPath = "/contact";

    const href = origin + basePath + contactPath;
    const button = document.createElement("a");
    button.href = href;
    button.textContent = "Let's Talk";
    button.className = "elementor-item menu-link custom-button";

    newItem.appendChild(button);
    menu.appendChild(newItem);
  }

  const iframe = document.querySelector("iframe");
  if (iframe) {
    iframe.addEventListener("mouseenter", () => {
      document.getElementById("cursor-trail").style.display = "none";
    });
    iframe.addEventListener("mouseleave", () => {
      document.getElementById("cursor-trail").style.display = "block";
    });
  }
});

// Function to hide loader
function hideLoader() {
  if (!document.body.classList.contains("loaded")) {
    document.body.classList.add("loaded");
  }
}

// Try to hide loader when window loads
window.addEventListener("load", hideLoader);

// Fallback: Hide loader after 5 seconds even if window.load doesn't fire
// This prevents the loader from staying stuck if any resource fails to load
setTimeout(function() {
  hideLoader();
}, 5000);


document.addEventListener("DOMContentLoaded", () => {
  const loadImage = (el) => {
    if (el.tagName === "IMG") {
     
    } else {
      el.style.backgroundImage = `url(${el.dataset.bg})`;
    }
    el.classList.remove("lazy-load", "lazy-bg");
  };

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          loadImage(entry.target);
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 }
  );

  const initLazyLoad = () => {
    document
      .querySelectorAll(".lazy-bg")
      .forEach((el) => observer.observe(el));
  };

  initLazyLoad();

  // Observe dynamically added content (Elementor, AJAX)
  const mutationObserver = new MutationObserver(() => initLazyLoad());
  mutationObserver.observe(document.body, { childList: true, subtree: true });
});



document.addEventListener('DOMContentLoaded', () => {
    const lazyImages = document.querySelectorAll('img.lazy-load');

    // Function to load image immediately
    const loadImage = (img) => {
        if (img.dataset.src) {
            img.src = img.dataset.src;
        }
        if (img.dataset.srcset) {
            img.srcset = img.dataset.srcset;
        }
        img.classList.remove('lazy-load');
    };

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    loadImage(entry.target);
                    obs.unobserve(entry.target);
                }
            });
        }, { rootMargin: '50px' }); // Start loading 50px before entering viewport

        lazyImages.forEach(img => observer.observe(img));
        
        // Fallback: Load all images after 2 seconds if they haven't loaded yet
        setTimeout(() => {
            lazyImages.forEach(img => {
                if (img.dataset.src && !img.src) {
                    loadImage(img);
                    observer.unobserve(img);
                }
            });
        }, 2000);
    } else {
        // Fallback for old browsers - load immediately
        lazyImages.forEach(img => loadImage(img));
    }
    
    if (typeof window.lazyLoadInstance !== "undefined") {
        window.lazyLoadInstance.update();
    }
});


document.addEventListener('DOMContentLoaded', function() {
    // Select all Elementor swiper containers
    const swipers = document.querySelectorAll('.elementor-swiper');

    swipers.forEach(swiper => {
        // Listen for slide change events
        swiper.addEventListener('slideChange', function() {
            // Trigger a window resize event to force layout recalculation
            window.dispatchEvent(new Event('resize'));
        });
    });
});

document.addEventListener("DOMContentLoaded", function() {
    const forceLoadImages = () => {
        const images = document.querySelectorAll('.no-lazyload img, img.lazy-load');

        images.forEach(img => {
            // If WP Rocket added lazy load attributes
            if (img.dataset.lazySrc) {
                img.src = img.dataset.lazySrc;
            }
            if (img.dataset.src && !img.src) {
                img.src = img.dataset.src;
            }
            if (img.dataset.srcset && !img.srcset) {
                img.srcset = img.dataset.srcset;
            }

            // Remove lazy loading attributes/classes
            img.removeAttribute('loading');
            img.classList.remove('lazyloaded', 'lazyload', 'lazy-load');

            // Force eager load
            img.loading = 'eager';
        });
    };

    // Run immediately
    forceLoadImages();

    // Run every 100ms for 1 second to catch WP Rocket overrides
    let count = 0;
    const interval = setInterval(() => {
        forceLoadImages();
        count++;
        if (count > 10) clearInterval(interval); // stop after ~1s
    }, 100);
    
    // Make Elementor invisible elements visible if Elementor JS fails to load
    setTimeout(() => {
        const invisibleElements = document.querySelectorAll('.elementor-invisible');
        invisibleElements.forEach(el => {
            // If Elementor hasn't made it visible after 3 seconds, do it manually
            if (el.classList.contains('elementor-invisible')) {
                el.classList.remove('elementor-invisible');
                el.style.opacity = '1';
                el.style.visibility = 'visible';
            }
        });
    }, 3000);
});






