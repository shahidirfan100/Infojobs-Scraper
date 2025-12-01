// InfoJobs Scraper - JSON API first, HTML fallback (HTTP only)
import { Actor, log } from 'apify';
import { CheerioCrawler, PlaywrightCrawler } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';

const API_BASE = 'https://api.infojobs.net/api/9';
const TOKEN_URL = 'https://www.infojobs.net/oauth/authorize';

const DEFAULT_HEADERS = {
    'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'upgrade-insecure-requests': '1',
};

const BLOCK_MARKERS = [
    'captcha',
    'distil',
    'geetest',
    'hemos detectado un uso inusual',
    'javascript is enabled',
    'are you human',
    'eres humano o un robot',
];

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const cfg = normalizeInput(input);

    log.info(
        `Booting InfoJobs actor | target=${cfg.maxItems} maxPages=${cfg.maxPages} pageSize=${cfg.pageSize}`,
    );

    const proxyConfiguration = await Actor.createProxyConfiguration(
        cfg.proxyConfiguration || { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    );

    const state = {
        saved: 0,
        blocked: 0,
        seenIds: new Set(),
        seenUrls: new Set(),
    };

    const apiCreds = getApiCreds();
    if (apiCreds) {
        const apiToken = await tryGetToken(apiCreds).catch((err) => {
            log.warning(`API token fetch failed (${err.message}). Will continue with HTML.`);
            return null;
        });
        if (apiToken) {
            await runApiHarvest(apiToken, cfg, state, proxyConfiguration);
        }
    } else {
        log.info('No API credentials provided (INFOJOBS_CLIENT_ID/SECRET). Skipping API mode.');
    }

    if (state.saved < cfg.maxItems) {
        // Try Playwright list extraction to bypass block pages, then fetch details via HTTP.
        await runPlaywrightListAndDetails(cfg, state, proxyConfiguration);
    }

    if (state.saved < cfg.maxItems) {
        // As a final fallback, still attempt pure HTML HTTP if Playwright gathered no URLs.
        await runHtmlHarvest(cfg, state, proxyConfiguration);
    }

    log.info(`Finished. Saved=${state.saved}, blocked=${state.blocked}`);
});

async function runApiHarvest(token, cfg, state, proxyConfiguration) {
    log.info('Running JSON API harvesting...');
    let page = 1;
    const maxPages = cfg.maxPages;
    while (state.saved < cfg.maxItems && page <= maxPages) {
        const { items, totalPages } = await fetchApiPage({
            token,
            page,
            pageSize: cfg.pageSize,
            keyword: cfg.keyword,
            location: cfg.location,
            category: cfg.category,
            proxyConfiguration,
        });

        if (!items.length) {
            log.info(`API page ${page} returned 0 items. Stopping API mode.`);
            break;
        }

        for (const item of items) {
            if (state.saved >= cfg.maxItems) break;
            if (cfg.dedupe && (state.seenIds.has(item.id) || state.seenUrls.has(item.link))) {
                continue;
            }
            if (cfg.dedupe) {
                state.seenIds.add(item.id);
                state.seenUrls.add(item.link);
            }

            let detail = {};
            if (cfg.collectDetails) {
                detail = await fetchApiDetail(token, item.id, proxyConfiguration).catch((err) => {
                    log.debug(`Detail fetch failed for ${item.id}: ${err.message}`);
                    return {};
                });
            }

            const payload = normalizeJobRecord({
                url: item.link,
                id: item.id,
                title: item.title,
                company: item.author?.name || item.company?.name || item.profile?.name,
                location: buildLocation(item),
                province: item.province?.value,
                city: item.city,
                salary: item.salaryDescription || item.salaryMin,
                job_type: item.contractType?.value || item.workDay?.value,
                date_posted: item.published || item.updateDate,
                remote: item.teleworking?.value,
                description_html: detail.description,
                description_text: detail.description ? stripHtml(detail.description) : null,
                source: 'infojobs-api',
            });

            await Actor.pushData(payload);
            state.saved += 1;
        }

        if (page >= totalPages) break;
        page += 1;
    }
}

async function runHtmlHarvest(cfg, state, proxyConfiguration) {
    log.info('Running HTML fallback (HTTP + Cheerio) ...');
    const startUrls = buildStartUrls(cfg);
    if (!startUrls.length) {
        log.warning('No start URLs built for HTML mode.');
        return;
    }

    const detailCandidates = new Set();
    const visitedListPages = new Set();

    const listCrawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: cfg.htmlListConcurrency,
        maxRequestRetries: 1,
        requestHandlerTimeoutSecs: 25,
        maxRequestsPerCrawl: cfg.maxPages * 5 + 10,
        async requestHandler({ request, body, $, log: crawlerLog, crawler }) {
            const pageIdx = request.userData.page || 1;
            const html = body?.toString?.() || '';
            if (isBlocked(html)) {
                state.blocked += 1;
                crawlerLog.warning(`[LIST][BLOCK] Blocked page detected: ${request.url}`);
                return;
            }

            if (!$) return;
            const base = request.loadedUrl || request.url;
            const links = extractJobLinksCheerio($, base);
            crawlerLog.info(`[LIST] Page ${pageIdx} yielded ${links.length} job links.`);

            for (const link of links) {
                if (detailCandidates.size >= cfg.maxItems * 3) break;
                if (cfg.dedupe && state.seenUrls.has(link)) continue;
                detailCandidates.add(link);
                if (cfg.dedupe) state.seenUrls.add(link);
            }

            if (pageIdx >= cfg.maxPages || state.saved >= cfg.maxItems) return;
            const next = findNextPageCheerio($, base);
            if (next && !visitedListPages.has(next)) {
                visitedListPages.add(next);
                await crawler.addRequests([{ url: next, userData: { page: pageIdx + 1 } }]);
            }
        },
    });

    await listCrawler.run(
        startUrls.map((u) => ({
            url: u,
            userData: { page: 1 },
            headers: DEFAULT_HEADERS,
        })),
    );

    const detailUrls = Array.from(detailCandidates).slice(0, cfg.maxItems * 3);
    if (!detailUrls.length) {
        log.warning('HTML mode found no detail URLs.');
        return;
    }

    const detailCrawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: cfg.htmlDetailConcurrency,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 25,
        async requestHandler({ request, body, $, log: crawlerLog }) {
            if (state.saved >= cfg.maxItems) return;
            const html = body?.toString?.() || '';
            if (isBlocked(html)) {
                state.blocked += 1;
                crawlerLog.warning(`[DETAIL][BLOCK] ${request.url}`);
                return;
            }

            const $dom = $ || cheerioLoad(html);
            const job = extractJobFromDetail($dom, request.url);
            if (!job.title) {
                crawlerLog.debug(`[DETAIL] Failed to parse: ${request.url}`);
                return;
            }

            await Actor.pushData(job);
            state.saved += 1;
            crawlerLog.info(`[DETAIL] Saved job #${state.saved}: ${job.title}`);
        },
    });

    await detailCrawler.run(
        detailUrls.map((u) => ({
            url: u,
            headers: DEFAULT_HEADERS,
        })),
    );
}

function getApiCreds() {
    const id = process.env.INFOJOBS_CLIENT_ID;
    const secret = process.env.INFOJOBS_CLIENT_SECRET;
    if (!id || !secret) return null;
    return { id, secret };
}

async function tryGetToken(creds) {
    if (!creds?.id || !creds?.secret) return null;
    const auth = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64');
    const res = await gotScraping({
        url: TOKEN_URL,
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        responseType: 'json',
        throwHttpErrors: true,
    });
    const token = res.body?.access_token;
    if (!token) throw new Error('Token endpoint returned no access_token');
    log.info('InfoJobs API token acquired.');
    return token;
}

async function fetchApiPage({ token, page, pageSize, keyword, location, category, proxyConfiguration }) {
    const searchParams = {
        maxResults: pageSize,
        page,
    };
    if (keyword) searchParams.q = keyword;
    if (location) searchParams.provinceIds = location;
    if (category) searchParams.categoryIds = category;

    const res = await gotScraping({
        url: `${API_BASE}/offer`,
        searchParams,
        headers: { Authorization: `Bearer ${token}` },
        proxyConfiguration,
        responseType: 'json',
        throwHttpErrors: false,
    });

    if (res.statusCode === 401 || res.statusCode === 403) {
        throw new Error(`API auth failed with status ${res.statusCode}`);
    }

    if (res.statusCode >= 500) {
        throw new Error(`API error ${res.statusCode}`);
    }

    const body = res.body || {};
    const items = body.items || body.offers || body.results || [];
    const totalPages = body.totalPages || body.totalPagesCount || body.totalPagesAvailable || page;

    return { items, totalPages };
}

async function fetchApiDetail(token, id, proxyConfiguration) {
    const res = await gotScraping({
        url: `${API_BASE}/offer/${id}`,
        headers: { Authorization: `Bearer ${token}` },
        proxyConfiguration,
        responseType: 'json',
        throwHttpErrors: false,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
        throw new Error(`Unauthorized for detail ${id}`);
    }
    return res.body || {};
}

function extractJobLinksCheerio($, baseUrl) {
    const links = [];
    $('a[href], [data-href]').each((_, el) => {
        const href = $(el).attr('href') || $(el).attr('data-href') || '';
        if (!href) return;
        if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
        if (!/\/of-[a-z0-9]{4,}/i.test(href)) return;
        const abs = toAbs(href, baseUrl);
        if (abs) links.push(abs.split('?')[0]);
    });
    return Array.from(new Set(links));
}

function findNextPageCheerio($, baseUrl) {
    const nextText = $('a[aria-label*="iguiente"], a:contains("Siguiente")').attr('href');
    if (nextText) {
        const abs = toAbs(nextText, baseUrl);
        if (abs) return abs;
    }
    try {
        const u = new URL(baseUrl);
        const current = Number(u.searchParams.get('page') || 1);
        u.searchParams.set('page', String(current + 1));
        return u.href;
    } catch {
        return null;
    }
}

function extractJobFromDetail($, url) {
    const jsonLd = parseJsonLdJob($) || {};
    const title =
        jsonLd.title ||
        $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content') ||
        null;

    const company =
        jsonLd.company ||
        $('[data-test="job-company"], [data-testid="company-name"]').first().text().trim() ||
        null;

    const location =
        jsonLd.location ||
        $('[data-test="job-location"]').first().text().trim() ||
        $('meta[property="ij:city"]').attr('content') ||
        null;

    const date =
        jsonLd.date_posted ||
        $('[data-test="job-published"] time[datetime], time[datetime]').first().attr('datetime') ||
        null;

    const descHtml =
        jsonLd.description_html ||
        $('#jobDescription').html() ||
        $('.ij-Offer-description, article').html() ||
        null;

    const descText =
        stripWhitespace(
            $('#jobDescription').text() ||
                $('.ij-Offer-description, article').text() ||
                $('body').text(),
        ) || null;

    return normalizeJobRecord({
        url,
        title,
        company,
        location,
        date_posted: date,
        description_html: descHtml,
        description_text: descText ? descText.slice(0, 6000) : null,
        source: 'infojobs-html',
    });
}

function parseJsonLdJob($) {
    const scripts = $('script[type="application/ld+json"]');
    for (const el of scripts.toArray()) {
        const text = $(el).contents().text();
        if (!text) continue;
        try {
            const data = JSON.parse(text.trim());
            const arr = Array.isArray(data) ? data : [data];
            const job = arr.find((d) => d['@type'] === 'JobPosting') || arr[0];
            if (job) {
                return {
                    title: job.title,
                    description_html: job.description,
                    company:
                        typeof job.hiringOrganization === 'string'
                            ? job.hiringOrganization
                            : job.hiringOrganization?.name,
                    location:
                        job.jobLocation?.address?.addressLocality ||
                        job.jobLocation?.address?.addressRegion ||
                        job.jobLocation?.address?.addressCountry,
                    date_posted: job.datePosted,
                };
            }
        } catch {
            // ignore
        }
    }
    return null;
}

function normalizeJobRecord(job) {
    const now = new Date().toISOString();
    return {
        url: job.url,
        id: job.id || job.url,
        title: job.title,
        company: job.company || null,
        location: job.location || null,
        province: job.province || null,
        city: job.city || null,
        salary: job.salary || null,
        job_type: job.job_type || null,
        date_posted: job.date_posted || null,
        remote: job.remote || null,
        description_html: job.description_html || null,
        description_text: job.description_text || null,
        source: job.source || 'infojobs',
        scraped_at: now,
    };
}

function stripHtml(html) {
    return stripWhitespace(cheerioLoad(`<div>${html || ''}</div>`)('div').text());
}

function stripWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function buildStartUrls(cfg) {
    const urls = [];
    const addIfValid = (raw) => {
        if (!raw) return;
        const u = typeof raw === 'string' ? raw : raw.url || raw.requests || raw.href;
        if (!u) return;
        try {
            const abs = new URL(u, 'https://www.infojobs.net').href;
            urls.push(abs);
        } catch {
            // ignore invalid
        }
    };

    if (Array.isArray(cfg.startUrls)) {
        for (const u of cfg.startUrls) addIfValid(u);
    }
    addIfValid(cfg.startUrl);

    if (!urls.length && (cfg.keyword || cfg.location)) {
        urls.push(buildSeoSearchUrl(cfg.keyword, cfg.location, cfg.category));
    }
    if (!urls.length) {
        urls.push('https://www.infojobs.net/ofertas-trabajo');
    }
    return Array.from(new Set(urls));
}

function buildSeoSearchUrl(keyword, location, category) {
    const base = 'https://www.infojobs.net/ofertas-trabajo';
    const slugify = (str) =>
        (str || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

    const kw = slugify(keyword);
    const loc = slugify(location);
    const cat = slugify(category);

    if (loc && kw && cat) return `${base}/${loc}/${cat}/${kw}`;
    if (loc && kw) return `${base}/${loc}/${kw}`;
    if (kw) return `${base}/${kw}`;
    return base;
}

function buildLocation(item) {
    if (!item) return null;
    const parts = [item.city, item.province?.value, item.country?.value].filter(Boolean);
    return parts.join(', ') || null;
}

function toAbs(href, base) {
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
}

function isBlocked(html) {
    const lower = (html || '').toLowerCase();
    return BLOCK_MARKERS.some((m) => lower.includes(m));
}

function normalizeInput(input) {
    const {
        keyword = '',
        location = '',
        category = '',
        startUrl,
        startUrls = [],
        results_wanted: resultsWanted = 100,
        max_pages: maxPagesRaw = 20,
        collectDetails = true,
        proxyConfiguration,
        dedupe = true,
    } = input;

    return {
        keyword,
        location,
        category,
        startUrl,
        startUrls,
        proxyConfiguration,
        collectDetails,
        dedupe,
        maxItems: Math.max(1, Number(resultsWanted) || 50),
        maxPages: Math.max(1, Number(maxPagesRaw) || 20),
        pageSize: 20,
        htmlListConcurrency: 2,
        htmlDetailConcurrency: 5,
    };
}
async function runPlaywrightListAndDetails(cfg, state, proxyConfiguration) {
    const startUrls = buildStartUrls(cfg);
    if (!startUrls.length) {
        log.warning('No start URLs built for Playwright phase.');
        return;
    }

    const detailUrls = new Set();
    let sessionCookies = [];
    let userAgent = DEFAULT_HEADERS['user-agent'];

    const listCrawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 2,
        minConcurrency: 1,
        maxRequestRetries: 1,
        requestHandlerTimeoutSecs: 35,
        navigationTimeoutSecs: 25,
        maxRequestsPerCrawl: cfg.maxPages * 3 + 5,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--lang=es-ES',
                    '--window-size=1920,1080',
                ],
            },
        },
        async requestHandler({ page, request, crawler, log: crawlerLog }) {
            const currentPage = request.userData.page || 1;

            await page.setExtraHTTPHeaders(DEFAULT_HEADERS);
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                // @ts-ignore
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            });

            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(500 + Math.random() * 500);

            if (!sessionCookies.length) {
                try {
                    const cookies = await page.context().cookies();
                    if (cookies?.length) sessionCookies = cookies;
                } catch {}
            }
            if (userAgent === DEFAULT_HEADERS['user-agent']) {
                try {
                    const ua = await page.evaluate(() => navigator.userAgent);
                    if (ua) userAgent = ua;
                } catch {}
            }

            const jobLinks = await page.$$eval('a[href], [data-href]', (els) => {
                const out = new Set();
                for (const el of els) {
                    const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
                    if (!href) continue;
                    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
                    if (!/\/of-[a-z0-9]{4,}/i.test(href)) continue;
                    out.add(href);
                }
                return Array.from(out);
            });

            const absLinks = jobLinks
                .map((h) => toAbs(h, request.url))
                .filter(Boolean)
                .map((u) => u.split('?')[0]);

            for (const u of absLinks) {
                if (detailUrls.size >= cfg.maxItems * 3) break;
                if (cfg.dedupe && state.seenUrls.has(u)) continue;
                detailUrls.add(u);
                if (cfg.dedupe) state.seenUrls.add(u);
            }

            if (detailUrls.size >= cfg.maxItems * 2 || currentPage >= cfg.maxPages) return;

            const nextHref = await page
                .$eval(
                    'a[aria-label*="iguiente"], a:has-text("Siguiente"), a:has-text("Siguiente >")',
                    (a) => a.getAttribute('href') || '',
                )
                .catch(() => null);

            if (nextHref) {
                const nextAbs = toAbs(nextHref, request.url);
                if (nextAbs) {
                    await crawler.addRequests([{ url: nextAbs, userData: { page: currentPage + 1 } }]);
                }
            }
        },
    });

    await listCrawler.run(
        startUrls.map((u) => ({
            url: u,
            userData: { page: 1 },
        })),
    );

    if (!detailUrls.size) {
        log.warning('Playwright phase found no detail URLs.');
        return;
    }

    const detailList = Array.from(detailUrls).slice(0, cfg.maxItems * 3);
    const detailCrawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: cfg.htmlDetailConcurrency,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 25,
        preNavigationHooks: [
            async ({ request }) => {
                request.headers ??= {};
                Object.assign(request.headers, DEFAULT_HEADERS);
                if (sessionCookies.length) {
                    request.headers.cookie = sessionCookies.map((c) => `${c.name}=${c.value}`).join('; ');
                }
                request.headers['user-agent'] = userAgent;
            },
        ],
        async requestHandler({ request, body, $, log: crawlerLog }) {
            if (state.saved >= cfg.maxItems) return;
            const html = body?.toString?.() || '';
            if (isBlocked(html)) {
                state.blocked += 1;
                crawlerLog.warning(`[DETAIL][BLOCK] ${request.url}`);
                return;
            }
            const $dom = $ || cheerioLoad(html);
            const job = extractJobFromDetail($dom, request.url);
            if (!job.title) return;
            await Actor.pushData(job);
            state.saved += 1;
            crawlerLog.info(`[DETAIL] Saved job #${state.saved}: ${job.title}`);
        },
    });

    await detailCrawler.run(
        detailList.map((u) => ({
            url: u,
        })),
    );
}
