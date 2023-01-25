/* global Strava sauce, jQuery */

sauce.ns('dashboard', function(ns) {

    const cardSelector = '[class*="Feed--entry-container--"]';

    async function feedEvent(action, category, count) {
        if (!count) {
            return;
        }
        await sauce.report.event('ActivityFeed', action, category, {
            nonInteraction: true,
            eventValue: count
        });
    }


    const _cardPropCache = new Map();
    function getCardProps(cardEl) {
        if (!_cardPropCache.has(cardEl)) {
            try {
                for (const [k, v] of Object.entries(cardEl)) {
                    if (k.startsWith('__reactEventHandlers$')) {
                        if (v && v.children && v.children.props) {
                            _cardPropCache.set(cardEl, v.children.props);
                        } else {
                            console.warn("Could not find props for:", cardEl);
                            _cardPropCache.set(cardEl, {});
                        }
                        break;
                    }
                }
            } catch(e) {
                sauce.report.error(e);
                _cardPropCache.set(cardEl, {});
            }
        }
        return _cardPropCache.get(cardEl) || {};
    }


    function hideCards(feedEl, label, filterFn) {
        let count = 0;
        const qs = `${cardSelector}:not(.hidden-by-sauce):not(.sauce-checked-${label})`;
        for (const x of feedEl.querySelectorAll(qs)) {
            x.classList.add(`sauce-checked-${label}`);
            try {
                if (filterFn(x)) {
                    console.debug("Hiding:", label, x);
                    x.classList.add('hidden-by-sauce');
                    count++;
                }
            } catch(e) {
                sauce.report.error(e);
            }
        }
        feedEvent('hide', label, count);
        return !!count;
    }


    function hideVirtual(feedEl) {
        return hideCards(feedEl, 'virtual-activity', isPeerVirtual);
    }


    function hideCommutes(feedEl) {
        return hideCards(feedEl, 'commute-activity', isPeerCommute);
    }


    function hideChallenges(feedEl) {
        return hideCards(feedEl, 'challenge-card', card =>
            getCardProps(card).entity === 'Challenge');
    }

    function hideWinter(feedEl) {
        return hideCards(feedEl, 'winter-activity', isPeerWinter);
    }


    function hidePromotions(feedEl) {
        return hideCards(feedEl, 'promo-card', card => {
            const ent = getCardProps(card).entity;
            return !!(ent && ent.match && ent.match(/Promo/));
        });
    }


    function isSelfActivity(props) {
        // Note we can't share the viewing/cur athlete ID var as the types are different.
        if (props.entity === 'Activity') {
            return props.activity.athlete.athleteId === props.viewingAthlete.id;
        } else if (props.entity === 'GroupActivity') {
            return props.rowData.activities.some(x => x.athlete_id === x.current_athlete_id);
        }
    }


    function isPeerVirtual(card) {
        const props = getCardProps(card);
        if (!isSelfActivity(props)) {
            if (props.entity === 'Activity') {
                if (props.activity.isVirtual) {
                    return true;
                } else if (props.activity.mapAndPhotos && props.activity.mapAndPhotos.photoList) {
                    // Catch the ones that don't claim to be virtual (but are).
                    const virtualTags = new Set(['zwift', 'trainerroad', 'peloton', 'virtual', 'whoop', 'wahoo systm']);
                    for (const x of props.activity.mapAndPhotos.photoList) {
                        if (x.enhanced_photo && virtualTags.has(x.enhanced_photo.name.toLowerCase())) {
                            return true;
                        }
                    }
                }
            } else if (props.entity === 'GroupActivity') {
                if (props.rowData.activities.every(x => x.is_virtual)) {
                    return true;
                }
            }
        }
        return false;
    }


    function isPeerCommute(card) {
        const props = getCardProps(card);
        if (!isSelfActivity(props)) {
            if (props.entity === 'Activity') {
                if (props.activity.isCommute) {
                    return true;
                }
            } else if (props.entity === 'GroupActivity') {
                if (props.rowData.activities.every(x => x.is_commute)) {
                    return true;
                }
            }
        }
        return false;
    }

    function isPeerWinter(card) {
        const props = getCardProps(card);
        const winterTags = new Set(['AlpineSki', 'NordicSki', 'Snowboard']);
        if (!isSelfActivity(props)) {
            if (props.entity === 'Activity') {
                if (winterTags.has(props.activity.type)) {
                    return true;
                }
            } else if (props.entity === 'GroupActivity') {
                if (props.rowData.activities.every(x => winterTags.has(x.type))) {
                    return true;
                }
            }
        }
        return false;
    }

    function filterFeed(feedEl) {
        try {
            _filterFeed(feedEl);
        } catch(e) {
            sauce.report.error(e);
        }
    }


    function _filterFeed(feedEl) {
        let resetFeedLoader = false;
        if (sauce.options['activity-hide-promotions']) {
            resetFeedLoader |= hidePromotions(feedEl);
        }
        if (sauce.options['activity-hide-virtual']) {
            resetFeedLoader |= hideVirtual(feedEl);
        }
        if (sauce.options['activity-hide-commutes']) {
            resetFeedLoader |= hideCommutes(feedEl);
        }
        if (sauce.options['activity-hide-challenges']) {
            resetFeedLoader |= hideChallenges(feedEl);
        }
        if (sauce.options['activity-hide-winter']) {
            resetFeedLoader |= hideWinter(feedEl);
        }
        if (resetFeedLoader) {
            // To prevent breaking infinite scroll we need to reset the feed loader state.
            // During first load pagination is not ready though, and will be run by the constructor.
            if (self.Strava && Strava.Dashboard && Strava.Dashboard.PaginationRouterFactory &&
                Strava.Dashboard.PaginationRouterFactory.view) {
                const view = Strava.Dashboard.PaginationRouterFactory.view;
                requestAnimationFrame(() => view.resetFeedLoader());
            }
        }
    }


    async function sendGAPageView(type) {
        await sauce.proxy.connected;
        await sauce.ga.sendSoon('pageview', {referrer: document.referrer});
    }


    function monitorFeed(feedEl) {
        const mo = new MutationObserver(() => {
            filterFeed(feedEl);
            resetKudoButton();
        });
        mo.observe(feedEl, {childList: true});
        filterFeed(feedEl);
    }


    let _kudoRateLimiter;
    async function getKudoRateLimiter() {
        if (!_kudoRateLimiter) {
            const jobs = await import(sauce.getURL('/src/common/jscoop/jobs.mjs'));

            class KudoRateLimiter extends jobs.RateLimiter {
                async getState() {
                    const storeKey = `kudo-rate-limiter-${this.label}`;
                    return await sauce.storage.get(storeKey);
                }

                async setState(state) {
                    const storeKey = `kudo-rate-limiter-${this.label}`;
                    await sauce.storage.set(storeKey, state);
                }
            }

            const g = new jobs.RateLimiterGroup();
            g.push(new KudoRateLimiter('hour', {period: 3600 * 1000, limit: 90}));
            await g.initialized();
            _kudoRateLimiter = g;
        }
        return _kudoRateLimiter;
    }


    async function loadAfterDOM() {
        if (!sauce.options['dashboard-disable-kudoall']) {
            await loadKudoAll();
        }
    }


    async function loadKudoAll() {
        // Strava kinda has bootstrap dropdowns, but most of the style is missing or broken.
        // I think it still is worth it to reuse the basics though (for now)  A lot of css
        // is required to fix this up though.
        await sauce.proxy.connected;
        await sauce.propDefined('jQuery.prototype.dropdown', {once: true, ignoreDefinedParents: true});
        const rl = await getKudoRateLimiter();
        const tpl = await sauce.template.getTemplate('kudo-all.html', 'dashboard');
        const filters = new Set((await sauce.storage.getPref('kudoAllFilters') || []));
        const suspended = rl.willSuspendFor();
        const $kudoAll = jQuery(await tpl({
            filters,
            rateLimited: !!suspended,
        }));
        if (suspended) {
            rl.wait().then(() => void $kudoAll.removeClass('limit-reached'));
        }
        jQuery('#dashboard-feed > .feed-header').append($kudoAll);
        $kudoAll.find('dropdown-toggle').dropdown();
        $kudoAll.on('click', 'label.filter', ev => void ev.stopPropagation()); // prevent menu close
        $kudoAll.on('input', 'label.filter input[type="checkbox"]', async ev => {
            const id = ev.currentTarget.name;
            if (ev.currentTarget.checked) {
                filters.add(id);
            } else {
                filters.delete(id);
            }
            await sauce.storage.setPref('kudoAllFilters', Array.from(filters));
            resetKudoButton();
        });
        $kudoAll.on('click', 'button.sauce-invoke', async ev => {
            const cards = document.querySelectorAll(`${cardSelector}:not(.hidden-by-sauce)`);
            const kudoButtons = [];
            const ignore = new Set(['FancyPromo', 'SimplePromo', 'Challenge', 'Club']);
            for (const card of cards) {
                const props = getCardProps(card);
                if ((filters.has('commutes') && isPeerCommute(card)) ||
                    (filters.has('virtual') && isPeerVirtual(card))) {
                    continue;
                }
                if (props.entity === 'Activity') {
                    if (props.activity.kudosAndComments.canKudo) {
                        // XXX I don't like using data-testid
                        kudoButtons.push(card.querySelector('button[data-testid="kudos_button"]'));
                    }
                } else if (props.entity === 'GroupActivity') {
                    for (const [kcId, kcSpec] of Object.entries(props.kudosAndComments)) {
                        if (kcSpec.canKudo) {
                            // kudosAndComments is unordered and we need to cross ref the rowData index with the
                            // DOM rendering of the activities withing the group to select the correct kudo btn.
                            const index = props.rowData.activities.findIndex(x => ('' + x.activity_id) === kcId);
                            // XXX I don't like using data-testid
                            const btn = card.querySelectorAll('button[data-testid="kudos_button"]')[index];
                            if (btn) {
                                kudoButtons.push(btn);
                            }
                        }
                    }
                } else if (props.entity === 'Post') {
                    if (props.post.can_kudo) {
                        // XXX I don't like using data-testid
                        kudoButtons.push(card.querySelector('button[data-testid="kudos_button"]'));
                    }
                } else if (!ignore.has(props.entity)) {
                    console.warn("Unhandled card type:", props.entity);
                }
            }
            const toKudo = Array.from(kudoButtons).filter(x =>
                x.querySelector(':scope > svg[data-testid="unfilled_kudos"]'));
            if (!toKudo.length) {
                $kudoAll.addClass('complete');
                return;
            }
            const $status = $kudoAll.find('.status');
            $status.text(`0 / ${toKudo.length}`);
            $kudoAll.addClass('active');
            let count = 0;
            try {
                for (const [i, x] of toKudo.entries()) {
                    // Rate limiter wait and anti-bot sleep.
                    const impendingSuspend = rl.willSuspendFor();
                    if (impendingSuspend > 10000) {
                        $kudoAll.removeClass('active').addClass('limit-reached');
                        if (count) {
                            feedEvent('kudo', 'all', count);
                            count = 0;
                        }
                    }
                    await rl.wait();
                    await sauce.sleep(150 + Math.random() ** 10 * 8000);  // low weighted jitter
                    $kudoAll.removeClass('limit-reached').addClass('active');
                    x.click();
                    count++;
                    $status.text(`${i + 1} / ${toKudo.length}`);
                }
            } finally {
                $kudoAll.removeClass('active').addClass('complete');
                if (count) {
                    feedEvent('kudo', 'all', count);
                }
            }
        });
    }


    function resetKudoButton() {
        const el = document.querySelector('#sauce-kudo-all');
        if (el) {
            el.classList.remove('complete');
        }
    }


    function load() {
        const feedSelector = '.main .feed-container .react-feed-component';
        const feedEl = document.querySelector(feedSelector);
        if (!feedEl) {
            // We're early, monitor the DOM until it's here..
            const mo = new MutationObserver(() => {
                const feedEl = document.querySelector(feedSelector);
                if (feedEl) {
                    mo.disconnect();
                    monitorFeed(feedEl);
                }
            });
            mo.observe(document.documentElement, {childList: true, subtree: true});
        } else {
            monitorFeed(feedEl);
        }
        if (sauce.options['activity-hide-media']) {
            document.documentElement.classList.add('sauce-hide-dashboard-media');
        }
        if (sauce.options['activity-hide-images']) {
            document.documentElement.classList.add('sauce-hide-dashboard-images');
        }
        if (sauce.options['activity-dense-mode']) {
            document.documentElement.classList.add('sauce-dense-dashboard');
        }
        if (!(['interactive', 'complete']).includes(document.readyState)) {
            addEventListener('DOMContentLoaded', () => loadAfterDOM().catch(sauce.report.error));
        } else {
            loadAfterDOM().catch(sauce.report.error);
        }
        sendGAPageView().catch(() => void 0);
    }


    return {
        load,
    };
});


(async function() {
    try {
        sauce.dashboard.load();
    } catch(e) {
        await sauce.report.error(e);
        throw e;
    }
})();
