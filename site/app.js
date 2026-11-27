/* Relay marketing site — small, dependency-free interactions */
(function () {
  "use strict";

  /* Toast + clipboard ---------------------------------------------------- */
  var toast = document.getElementById("toast");
  var toastTimer;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 2200);
  }

  function legacyCopy(text) {
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    var ok = document.execCommand("copy");
    document.body.removeChild(field);
    return ok;
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { showToast("Copied to clipboard"); },
        function () {
          legacyCopy(text);
          showToast("Copied to clipboard");
        }
      );
    } else {
      legacyCopy(text);
      showToast("Copied to clipboard");
    }
  }

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      copyText(button.getAttribute("data-copy"));
    });
  });

  /* Mobile navigation ---------------------------------------------------- */
  var menuToggle = document.getElementById("menuToggle");
  var navLinks = document.getElementById("navLinks");

  function closeMenu() {
    if (!navLinks || !menuToggle) return;
    navLinks.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open menu");
  }

  if (menuToggle && navLinks) {
    menuToggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("is-open");
      menuToggle.setAttribute("aria-expanded", String(open));
      menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });

    navLinks.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeMenu();
    });

    document.addEventListener("click", function (event) {
      if (!navLinks.contains(event.target) && !menuToggle.contains(event.target)) closeMenu();
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 960) closeMenu();
    });
  }

  /* Showcase tabs -------------------------------------------------------- */
  var showcaseCaptions = {
    overview: "Your chats in the sidebar, formatted replies, and one box to ask any connected CLI.",
    failover: "When a CLI hits its limit, Relay tells you and hands the same turn to the next ready one.",
    preview: "Open HTML or SVG from a reply beside the chat. Scripts and network loads stay blocked.",
    search: "Press Command K to find any past chat or run a command.",
    settings: "Choose how turns are routed and which CLI goes first."
  };
  var showcaseCaption = document.getElementById("showcaseCaption");
  var showcaseTabs = Array.prototype.slice.call(document.querySelectorAll("[data-showcase]"));

  function activateShowcase(name, focus) {
    showcaseTabs.forEach(function (tab) {
      var active = tab.getAttribute("data-showcase") === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("tabindex", active ? "0" : "-1");
      if (active && focus) tab.focus();
    });

    document.querySelectorAll("[data-panel]").forEach(function (panel) {
      var active = panel.getAttribute("data-panel") === name;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });

    if (showcaseCaption && showcaseCaptions[name]) {
      showcaseCaption.textContent = showcaseCaptions[name];
    }
  }

  showcaseTabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () {
      activateShowcase(tab.getAttribute("data-showcase"));
    });
    tab.addEventListener("keydown", function (event) {
      var next;
      if (event.key === "ArrowRight") next = (index + 1) % showcaseTabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + showcaseTabs.length) % showcaseTabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = showcaseTabs.length - 1;
      else return;
      event.preventDefault();
      activateShowcase(showcaseTabs[next].getAttribute("data-showcase"), true);
    });
  });

  /* Credit strategy selector --------------------------------------------- */
  var strategies = {
    priority: {
      name: "Strict priority",
      description: "Ask your favorite CLI first. Relay fails over down your order only when credits expire or a backend is marked in cooldown.",
      command: "relay strategy priority"
    },
    pool: {
      name: "Credit pool",
      description: "Spread turns round-robin across ready backends so no single provider hits an hourly or daily limit while the others sit idle.",
      command: "relay strategy pool"
    },
    "free-first": {
      name: "Free tier first",
      description: "Burn zero-cost quotas first, then reserve premium credits on Claude and Junie for when the free tier runs dry.",
      command: "relay strategy free-first"
    }
  };

  var strategyPanel = document.querySelector(".strategy-panel");
  var strategyButtons = Array.prototype.slice.call(document.querySelectorAll("[data-strategy-choice]"));
  var strategyName = document.getElementById("strategyName");
  var strategyDescription = document.getElementById("strategyDescription");
  var strategyCommand = document.getElementById("strategyCommand");
  var strategyCopy = document.getElementById("strategyCopy");

  function activateStrategy(name, focus) {
    var data = strategies[name];
    if (!data || !strategyPanel) return;

    strategyPanel.setAttribute("data-strategy", name);
    if (strategyName) strategyName.textContent = data.name;
    if (strategyDescription) strategyDescription.textContent = data.description;
    if (strategyCommand) strategyCommand.textContent = data.command;
    if (strategyCopy) strategyCopy.setAttribute("aria-label", "Copy command: " + data.command);

    strategyButtons.forEach(function (button) {
      var active = button.getAttribute("data-strategy-choice") === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("tabindex", active ? "0" : "-1");
      if (active && focus) button.focus();
    });
  }

  strategyButtons.forEach(function (button, index) {
    button.addEventListener("click", function () {
      activateStrategy(button.getAttribute("data-strategy-choice"));
    });
    button.addEventListener("keydown", function (event) {
      var next;
      if (event.key === "ArrowRight") next = (index + 1) % strategyButtons.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + strategyButtons.length) % strategyButtons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = strategyButtons.length - 1;
      else return;
      event.preventDefault();
      activateStrategy(strategyButtons[next].getAttribute("data-strategy-choice"), true);
    });
  });

  if (strategyCopy) {
    strategyCopy.addEventListener("click", function () {
      copyText(strategyCommand ? strategyCommand.textContent : "");
    });
  }

  /* Scroll reveal -------------------------------------------------------- */
  var revealItems = document.querySelectorAll(".reveal");
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if ("IntersectionObserver" in window && !reducedMotion) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });
    revealItems.forEach(function (item) { observer.observe(item); });
  } else {
    revealItems.forEach(function (item) { item.classList.add("is-visible"); });
  }

  /* Sliding thumbs under the segmented controls --------------------------- */
  // a CSS transition retargets from the thumb's current position, so a second
  // click mid-move redirects it without a jump
  var groups = Array.prototype.slice.call(document.querySelectorAll(".showcase-tabs, .segmented")).map(function (group) {
    var thumb = document.createElement("span");
    thumb.className = "segment-thumb";
    thumb.setAttribute("aria-hidden", "true");
    group.insertBefore(thumb, group.firstChild);

    function place() {
      var active = group.querySelector(".is-active");
      if (!active || !active.offsetWidth) return;
      thumb.style.width = active.offsetWidth + "px";
      thumb.style.transform = "translateX(" + active.offsetLeft + "px)";
    }

    thumb.style.transition = "none";
    place();
    group.classList.add("has-thumb");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { thumb.style.transition = ""; });
    });
    // after the buttons' own handlers have moved .is-active
    group.addEventListener("click", place);
    group.addEventListener("keyup", place);
    return place;
  });

  function placeThumbs() {
    groups.forEach(function (place) { place(); });
  }
  window.addEventListener("resize", placeThumbs);
  window.addEventListener("load", placeThumbs);

  /* Header edge appears once content scrolls under it ---------------------- */
  var header = document.querySelector(".site-header");
  function markScrolled() {
    if (header) header.classList.toggle("is-scrolled", window.scrollY > 4);
  }
  window.addEventListener("scroll", markScrolled, { passive: true });
  markScrolled();

  /* Footer year ----------------------------------------------------------- */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
