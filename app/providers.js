/* Signal demo console — the built-in sources, fetched for real.
   Loaded after sources.js, before scheduler.js.

   Ported from reference/signal/collector/sources/*.ts. Each site publishes the listing endpoint
   its own front end calls: no account, no login, no scraping of rendered pages. Requests go
   through SignalSources.fetchText, which tries the browser first and falls back to the fetch
   helper (which honours robots.txt) for sites that refuse cross-origin reads.

   A provider:
     id        matches a source in SignalData.SOURCES, so the inbox labels rows with it
     everyMs   how often it is worth checking
     missing(prefs)  null when it can run, otherwise what the user still has to add
     poll({ prefs, cursor, setCursor, warn }) -> Promise<items>
   An item is what SignalSources.importItems takes: { title, body, url, deadline, kind, external_id }. */
(function (global) {
  "use strict";

  var S = global.SignalSources;
  var HOUR = 3600000;
  var MAX_PER_SOURCE = 60;

  function clean(s, max) { return S.clean(s, max); }
  function item(o, kind) { return S.makeItem(o, kind); }
  function date(v) { return S.parseDate(v); }
  function text(html) { return S.stripHtml(String(html == null ? "" : html)); }

  function names(list, key) {
    return (list || []).map(function (x) { return typeof x === "string" ? x : x && x[key || "name"]; })
      .filter(Boolean).join(", ");
  }
  function lines(parts) { return parts.filter(Boolean).join(" · "); }

  function getJson(url) {
    return S.fetchText({ url: url, accept: "application/json" }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw new Error("That source didn't answer with JSON."); }
    });
  }
  function postJson(url, body) {
    return S.fetchText({ url: url, method: "POST", body: JSON.stringify(body), accept: "application/json" }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw new Error("That source didn't answer with JSON."); }
    });
  }

  /* ---------------- Devpost ---------------- */

  /* "Sep 11, 2026" · "Aug 12 - Sep 30, 2026" · "Sep 12 - 30, 2026" — the end date can borrow
     the month from the start. */
  function devpostEnd(s) {
    if (!s) return null;
    var parts = String(s).split(/\s+-\s+/);
    var end = parts[parts.length - 1].trim();
    if (/^\d{1,2}, \d{4}$/.test(end)) end = parts[0].trim().split(" ")[0] + " " + end;
    return date(end);
  }

  var devpost = {
    id: "devpost",
    everyMs: 3 * HOUR,
    missing: function () { return null; },
    poll: function (ctx) {
      var out = [];
      function page(n) {
        if (n > 3) return Promise.resolve();
        return getJson("https://devpost.com/api/hackathons?page=" + n + "&status[]=upcoming&status[]=open&order_by=recently-added")
          .then(function (j) {
            var list = j.hackathons || [];
            list.forEach(function (h) {
              if (h.invite_only) return;
              out.push(item({
                external_id: "devpost:" + h.id,
                title: h.title,
                url: h.url,
                deadline: devpostEnd(h.submission_period_dates),
                body: lines([
                  h.submission_period_dates && "Submissions: " + h.submission_period_dates,
                  h.displayed_location && h.displayed_location.location,
                  h.prize_amount && "Prizes: " + text(h.prize_amount),
                  h.themes && h.themes.length && "Themes: " + names(h.themes),
                  h.registrations_count != null && h.registrations_count + " registered",
                  h.organization_name
                ])
              }, "hackathon"));
            });
            if (list.length < 9) return; // Devpost pages are 9 long
            return page(n + 1);
          });
      }
      return page(1).then(function () { return out; });
    }
  };

  /* ---------------- Devfolio ---------------- */

  var devfolio = {
    id: "devfolio",
    everyMs: 3 * HOUR,
    missing: function () { return null; },
    poll: function () {
      return postJson("https://api.devfolio.co/api/search/hackathons", { type: "application_open", from: 0, size: 50 })
        .then(function (j) {
          var hits = (j.hits && j.hits.hits) || [];
          return hits.map(function (hit) {
            var h = hit._source || {};
            var set = h.hackathon_setting || {};
            return item({
              external_id: "devfolio:" + h.uuid,
              title: h.name,
              url: set.subdomain ? "https://" + set.subdomain + ".devfolio.co/" : "https://devfolio.co/hackathons",
              deadline: date(set.reg_ends_at),
              body: lines([
                h.tagline,
                h.is_online ? "Online" : [h.city, h.state, h.country].filter(Boolean).join(", "),
                h.starts_at && "Runs " + date(h.starts_at) + " → " + date(h.ends_at),
                h.themes && h.themes.length && "Themes: " + names(h.themes),
                clean(text(h.desc), 600)
              ])
            }, "hackathon");
          });
        });
    }
  };

  /* ---------------- Unstop ---------------- */

  var unstop = {
    id: "unstop",
    everyMs: 3 * HOUR,
    missing: function () { return null; },
    poll: function () {
      var out = [];
      function page(n) {
        return getJson("https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&page=" + n + "&per_page=30&oppstatus=open")
          .then(function (j) {
            var data = j.data || {};
            (data.data || []).forEach(function (o) {
              var eligible = (o.filters || []).filter(function (f) { return f && f.type === "eligible"; });
              out.push(item({
                external_id: "unstop:" + o.id,
                title: o.title,
                url: o.seo_url || ("https://unstop.com/" + o.public_url),
                deadline: date((o.regnRequirements && o.regnRequirements.end_regn_dt) || o.end_date),
                body: lines([
                  o.organisation && o.organisation.name,
                  o.region && "Mode: " + o.region,
                  o.address_with_country_logo && o.address_with_country_logo.city,
                  eligible.length && "Eligible: " + names(eligible),
                  o.required_skills && o.required_skills.length && "Skills: " + names(o.required_skills, "skill_name"),
                  o.isPaid && "Paid entry",
                  clean(text(o.details), 600)
                ])
              }, "hackathon"));
            });
            if (n >= (data.last_page || 1) || n >= 2) return;
            return page(n + 1);
          });
      }
      return page(1).then(function () { return out; });
    }
  };

  /* ---------------- MLH ---------------- */

  var mlh = {
    id: "mlh",
    everyMs: 12 * HOUR,
    missing: function () { return null; },
    poll: function () {
      var now = new Date();
      var season = now.getFullYear() + (now.getMonth() >= 6 ? 1 : 0); // seasons roll over in summer
      return S.fetchText({ url: "https://www.mlh.com/seasons/" + season + "/events" }).then(function (html) {
        // an Inertia page: the props ride along as JSON in a script tag
        var m = html.match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/);
        if (!m) throw new Error("The MLH page layout changed, so Signal couldn't read its events.");
        var props = JSON.parse(m[1]).props || {};
        var events = props.upcomingEvents || [];
        return events.map(function (e) {
          var loc = typeof e.location === "string" ? e.location : e.location && e.location.name;
          return item({
            external_id: "mlh:" + (e.id || e.slug),
            title: e.name,
            url: e.url ? new URL(e.url, "https://www.mlh.com").href : e.websiteUrl,
            deadline: date(e.startsAt), // MLH has no separate registration close — the start is the deadline
            body: lines([e.dateRange, loc, e.formatType && "Format: " + e.formatType, e.region])
          }, "hackathon");
        });
      });
    }
  };

  /* ---------------- WikiCFP ---------------- */

  var wikicfp = {
    id: "wikicfp",
    everyMs: 6 * HOUR,
    missing: function (prefs) {
      return (prefs.cfpCategories || []).length ? null : "Add a category under Sources to start.";
    },
    poll: function (ctx) {
      var cats = (ctx.prefs.cfpCategories || []).slice(0, 6);
      var out = [];
      function next(i) {
        if (i >= cats.length) return Promise.resolve();
        var cat = cats[i];
        // http only: wikicfp.com doesn't listen on 443
        return S.fetchText({ url: "http://www.wikicfp.com/cfp/rss?cat=" + encodeURIComponent(cat) })
          .then(function (xml) {
            S.parseFeedText(xml).slice(0, MAX_PER_SOURCE).forEach(function (e) {
              out.push(item({
                external_id: "wikicfp:" + (e.external_id || e.url),
                title: e.title,
                url: e.url,
                // The submission deadline is only on the event page; the feed doesn't carry it.
                deadline: null,
                body: lines(["WikiCFP · " + cat, clean(e.body, 400)])
              }, "cfp"));
            });
          }, function (e) {
            ctx.warn(cat + ": " + ((e && e.message) || "couldn't be read"));
          }).then(function () { return next(i + 1); });
      }
      return next(0).then(function () { return out; });
    }
  };

  /* ---------------- RSS / Google Alerts ---------------- */

  /* Google Alerts wraps every link in a google.com/url redirect — unwrap it. */
  function unwrap(u) {
    try {
      var p = new URL(u);
      if (/(^|\.)google\.com$/.test(p.hostname) && p.pathname === "/url") return p.searchParams.get("url") || u;
    } catch (e) {}
    return u;
  }

  var feeds = {
    id: "feeds",
    everyMs: 30 * 60000,
    missing: function (prefs) {
      return (prefs.feeds || []).length ? null : "Add a feed link under Sources to start.";
    },
    poll: function (ctx) {
      var list = (ctx.prefs.feeds || []).slice(0, 10);
      var out = [];
      function next(i) {
        if (i >= list.length) return Promise.resolve();
        var f = list[i];
        var url = typeof f === "string" ? f : f.url;
        var label = (typeof f === "object" && f.label) || S.hostOf(url) || "Feed";
        return S.fetchText({ url: url }).then(function (xml) {
          S.parseFeedText(xml).slice(0, MAX_PER_SOURCE).forEach(function (e) {
            var link = unwrap(e.url);
            out.push(item({
              external_id: "feed:" + url + "|" + (e.external_id || link),
              title: e.title,
              url: link,
              deadline: e.deadline,
              body: lines([label, clean(e.body, 500)])
            }, /linkedin\.com\//.test(link) ? "post" : null));
          });
        }, function (e) {
          ctx.warn(label + ": " + ((e && e.message) || "couldn't be read"));
        }).then(function () { return next(i + 1); });
      }
      return next(0).then(function () { return out; });
    }
  };

  /* ---------------- Page watch ---------------- */

  var watch = {
    id: "watch",
    everyMs: 6 * HOUR,
    missing: function (prefs) {
      return (prefs.watch || []).length ? null : "Add a page under Sources to start.";
    },
    poll: function (ctx) {
      var list = (ctx.prefs.watch || []).slice(0, 10);
      var out = [];
      function next(i) {
        if (i >= list.length) return Promise.resolve();
        var w = list[i];
        var url = typeof w === "string" ? w : w.url;
        var label = (typeof w === "object" && w.label) || S.hostOf(url) || "Watched page";
        return S.fetchText({ url: url, render: true }).then(function (html) {
          var r = S._test.watchPage({ id: "watch:" + url, url: url, name: label }, html);
          out = out.concat(r.items);
          if (r.note) ctx.warn(label + ": " + r.note);
        }, function (e) {
          ctx.warn(label + ": " + ((e && e.message) || "couldn't be read"));
        }).then(function () { return next(i + 1); });
      }
      return next(0).then(function () { return out; });
    }
  };

  var ALL = [devpost, devfolio, unstop, mlh, wikicfp, feeds, watch];

  global.SignalProviders = {
    ALL: ALL,
    byId: function (id) { return ALL.filter(function (p) { return p.id === id; })[0] || null; },
    _test: { devpostEnd: devpostEnd, unwrap: unwrap }
  };
})(window);
