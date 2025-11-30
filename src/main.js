// InfoJobs Scraper - Playwright-only (stable, production-ready)

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        category = '',
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 20,
        collectDetails = true, // If false, scrape only list cards
        startUrl,
        startUrls,
        url,
        proxyConfiguration,
        maxConcurrency: MAX_CONCURRENCY_INPUT,
    } = input;

    const RESULTS_WANTED = Math.max(1, Number(RESULTS_WANTED_RAW) || 1);
    const MAX_PAGES = Math.max(1, Number(MAX_PAGES_RAW) || 1);
    const MAX_CONCURRENCY = Math.min(
        Math.max(1, Number(MAX_CONCURRENCY_INPUT) || 2),
        5, // hard upper bound for cost & stealth
    );

    log.info(
        `Starting InfoJobs scraper - Target: ${RESULTS_WANTED} jobs, Max pages: ${MAX_PAGES}, Max concurrency: ${MAX_CONCURRENCY}`,
    );

    // --------- INITIAL URLS ---------

    const initialUrls = [];
    if (Array.isArray(startUrls) && startUrls.length) initialUrls.push(...startUrls.map(String));
    if (startUrl) initialUrls.push(String(startUrl));
    if (url) initialUrls.push(String(url));

    if (!initialUrls.length) {
        initialUrls.push(buildSearchUrl(keyword, location, category));
    }

    log.info(`Initial URLs: ${JSON.stringify(initialUrls, null, 2)}`);

    const proxyConf = await Actor.createProxyConfiguration(
        proxyConfiguration || { useApifyProxy: true },
    );

    let saved = 0;
    const seenUrls = new Set();
    const visitedPages = new Set();

    // ---------- PLAYWRIGHT CRAWLER (LIST + DETAIL) ----------

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 60,
        maxRequestsPerCrawl: RESULTS_WANTED * (collectDetails ? 2 : 1) + MAX_PAGES * 2 + 20,
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
        preNavigationHooks: [
            async ({ page, request, log: crawlerLog }) => {
                // Basic headers for every request
                await page.setExtraHTTPHeaders({
                    'user-agent': DEFAULT_UA,
                    'accept-language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
                    accept:
                        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'upgrade-insecure-requests': '1',
                });

                // Stealth-ish tweaks
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => undefined,
                    });
                    // @ts-ignore
                    window.chrome = { runtime: {} };
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['es-ES', 'es'],
                    });
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5],
                    });
                });

                crawlerLog.debug(
                    `[PRENAV] ${request.userData.label || 'LIST'} => ${request.url}`,
                );
            },
        ],
        async requestHandler(ctx) {
            const { page, request, log: crawlerLog } = ctx;
            const label = request.userData.label || 'LIST';

            if (saved >= RESULTS_WANTED) {
                crawlerLog.info('[GLOBAL] Target reached, skipping navigation.');
                return;
            }

            const url = request.url;
            if (visitedPages.has(url)) {
                crawlerLog.debug(`[SKIP] Already visited page: ${url}`);
                return;
            }
            visitedPages.add(url);

            crawlerLog.info(`[${label}] Navigating to ${url}`);

            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });

            // let page settle a bit
            await page.waitForTimeout(1000 + Math.random() * 1000);
            await safeScroll(page, crawlerLog);

            const html = await page.content();
            const text = await page.textContent('body').catch(() => '') || '';

            if (isBlocked(html, text)) {
                crawlerLog.warning(`[BLOCK] Detected potential block on ${label} page: ${url}`);
                return; // For now, just skip. Can be extended to smart re-tries if needed.
            }

            if (label === 'DETAIL') {
                await handleDetailPage(ctx);
            } else {
                await handleListPage(ctx, RESULTS_WANTED, MAX_PAGES, collectDetails, seenUrls, () => {
                    saved++; // this callback is NOT used (we count only when pushing jobs)
                });
            }
        },
        async failedRequestHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error(
                `[FAILED] ${request.userData.label || 'LIST'} ${request.url} => ${error?.message}`,
            );
        },
    });

    const startingRequests = initialUrls.slice(0, MAX_PAGES).map((u) => ({
        url: u,
        userData: { label: 'LIST', page: 1 },
    }));

    await crawler.run(startingRequests);

    log.info(`✓ Scraping finished. Total jobs saved: ${saved}`);

    // ====================== HELPERS ======================

    function buildSearchUrl(keyword, location, category) {
        // This is close to what the site uses internally (still works with a real browser).
        const url = new URL(
            'https://www.infojobs.net/jobsearch/search-results/list.xhtml',
        );
        if (keyword) url.searchParams.set('keyword', String(keyword));
        if (location) url.searchParams.set('provincia', String(location));
        if (category) url.searchParams.set('category', String(category));
        url.searchParams.set('sortBy', 'PUBLICATION_DATE');
        url.searchParams.set('page', '1');
        return url.href;
    }

    function isBlocked(html, text) {
        const lower = (text || '').toLowerCase();
        return (
            lower.includes("we can't identify your browser") ||
            lower.includes('javascript is enabled') ||
            lower.includes('hemos detectado un uso inusual') ||
            ((html || '').length < 2500 &&
                lower.includes('javascript') &&
                lower.includes('browser'))
        );
    }

    async function safeScroll(page, logger) {
        try {
            await page.evaluate(() => {
                window.scrollTo(0, 400);
            });
        } catch (e) {
            logger.debug(`[SCROLL] Failed: ${e.message}`);
        }
    }

    function toAbs(href, base) {
        try {
            return new URL(href, base).href;
        } catch {
            return null;
        }
    }

    /**
     * Extract job detail URLs ("/of-i...") from a list page.
     */
    async function extractJobLinksFromPage(page, baseUrl) {
        const anchors = await page.$$eval('a[href*="/of-i"]', (els) =>
            els
                .map((a) => a.getAttribute('href') || '')
                .filter((href) => href && /\/of-i[a-z0-9]/i.test(href)),
        );
        const unique = Array.from(new Set(anchors));
        return unique
            .map((href) => toAbs(href, baseUrl))
            .filter((u) => typeof u === 'string');
    }

    /**
     * Find URL of next page (from DOM, or by incrementing ?page).
     */
    async function findNextPageUrlPlaywright(page, currentUrl) {
        // Try DOM-based "Siguiente" link
        const nextHref = await page
            .$eval(
                'a[aria-label*="iguiente"], a:has-text("Siguiente")',
                (a) => a.getAttribute('href') || '',
            )
            .catch(() => null);

        if (nextHref) {
            const abs = toAbs(nextHref, currentUrl);
            if (abs) return abs;
        }

        // Fallback: increment page param
        try {
            const u = new URL(currentUrl);
            const currentPage = parseInt(u.searchParams.get('page') || '1', 10);
            const nextPage = currentPage + 1;
            u.searchParams.set('page', String(nextPage));
            return u.href;
        } catch {
            return null;
        }
    }

    async function handleListPage(
        ctx,
        RESULTS_WANTED,
        MAX_PAGES,
        collectDetails,
        seenUrls,
        incrementSavedFromList,
    ) {
        const { page, request, crawler, log: crawlerLog } = ctx;
        const currentPage = request.userData.page || 1;

        // Wait for offers container to appear (best-effort).
        await page
            .waitForSelector('a[href*="/of-i"], article, [data-test="offer-card"]', {
                timeout: 15000,
            })
            .catch(() => {});

        const jobLinks = await extractJobLinksFromPage(page, request.url);
        crawlerLog.info(
            `[LIST] Page ${currentPage} => found ${jobLinks.length} job links on ${request.url}`,
        );

        for (const jobUrl of jobLinks) {
            if (saved >= RESULTS_WANTED) break;
            if (seenUrls.has(jobUrl)) continue;
            seenUrls.add(jobUrl);

            if (collectDetails) {
                await crawler.addRequests([
                    {
                        url: jobUrl,
                        userData: { label: 'DETAIL' },
                    },
                ]);
            } else {
                await Actor.pushData({
                    url: jobUrl,
                    source: 'infojobs',
                });
                saved++;
                incrementSavedFromList();
            }
        }

        if (saved >= RESULTS_WANTED) {
            crawlerLog.info('[LIST] Target job count reached – not enqueueing further pages.');
            return;
        }

        if (currentPage >= MAX_PAGES) {
            crawlerLog.info(
                `[LIST] Reached MAX_PAGES (${MAX_PAGES}), not enqueueing further pages.`,
            );
            return;
        }

        const nextUrl = await findNextPageUrlPlaywright(page, request.url);
        if (!nextUrl || seenUrls.has(nextUrl)) {
            crawlerLog.info('[PAGINATION] No next page URL found or already seen.');
            return;
        }

        seenUrls.add(nextUrl);
        await crawler.addRequests([
            {
                url: nextUrl,
                userData: { label: 'LIST', page: currentPage + 1 },
            },
        ]);

        crawlerLog.info(
            `[PAGINATION] Enqueued next page: ${nextUrl} (page ${currentPage + 1})`,
        );
    }

    function parseJobFromJsonLdObjects(objs) {
        if (!objs) return null;

        const firstJobPosting =
            objs.find((d) => d && d['@type'] === 'JobPosting') || objs[0];

        if (!firstJobPosting) return null;

        const data = firstJobPosting;
        const loc = data.jobLocation?.address;
        const location =
            loc?.addressLocality || loc?.addressRegion || loc?.addressCountry || null;

        const hiringOrg = data.hiringOrganization;
        const company =
            (typeof hiringOrg === 'string'
                ? hiringOrg
                : hiringOrg?.name) || null;

        return {
            title: data.title || null,
            company,
            date_posted: data.datePosted || null,
            description_html: data.description || null,
            location,
        };
    }

    async function parseJobJsonLdFromPage(page) {
        try {
            const rawJsons = await page.$$eval(
                'script[type="application/ld+json"]',
                (scripts) =>
                    scripts.map((s) => s.textContent || s.innerText || '').filter(Boolean),
            );

            const parsedObjects = [];
            for (const raw of rawJsons) {
                try {
                    const cleaned = raw.trim();
                    if (!cleaned) continue;
                    const data = JSON.parse(cleaned);
                    if (Array.isArray(data)) parsedObjects.push(...data);
                    else parsedObjects.push(data);
                } catch {
                    // ignore individual JSON parse errors
                }
            }

            return parseJobFromJsonLdObjects(parsedObjects);
        } catch {
            return null;
        }
    }

    async function handleDetailPage(ctx) {
        const { page, request, log: crawlerLog } = ctx;

        if (saved >= RESULTS_WANTED) {
            crawlerLog.debug('[DETAIL] Target already reached, skipping.');
            return;
        }

        const url = request.url;
        crawlerLog.info(`[DETAIL] Extracting job from ${url}`);

        // Let detail page load
        await page
            .waitForSelector('h1, [data-test="offerTitle"]', { timeout: 15000 })
            .catch(() => {});

        const html = await page.content();
        const text = (await page.textContent('body').catch(() => '')) || '';

        if (isBlocked(html, text)) {
            crawlerLog.warning(`[DETAIL][BLOCK] Detected block on detail page: ${url}`);
            return;
        }

        // JSON-LD first
        const jsonLdJob = (await parseJobJsonLdFromPage(page)) || {};

        const titleDom =
            (await page.textContent('h1').catch(() => ''))?.trim() ||
            (await page
                .getAttribute('meta[property="og:title"]', 'content')
                .catch(() => null)) ||
            null;

        const companyDom =
            (await page
                .textContent(
                    '[data-test="job-company"], .ij-Offer-info h3, .js-LogoAndName-companyName',
                )
                .catch(() => ''))?.trim() || null;

        const locationDom =
            (await page
                .textContent(
                    '[data-test="job-location"], .ij-Offer-info li:has-text("Ubicación"), .ij-Offer-info li:has-text("ubicación")',
                )
                .catch(() => ''))?.trim() || null;

        const dateDom =
            (await page
                .getAttribute('[data-test="job-published"] time[datetime]', 'datetime')
                .catch(() => null)) ||
            (await page.getAttribute('time[datetime]', 'datetime').catch(() => null)) ||
            null;

        const descHtml =
            (await page
                .innerHTML('#jobDescription')
                .catch(() => null)) ||
            (await page
                .innerHTML('.ij-Offer-description')
                .catch(() => null)) ||
            (await page.innerHTML('article').catch(() => null)) ||
            null;

        const descTextRaw =
            (await page
                .textContent('#jobDescription')
                .catch(() => '')) ||
            (await page.textContent('.ij-Offer-description').catch(() => '')) ||
            (await page.textContent('article').catch(() => '')) ||
            text;

        const descText = (descTextRaw || '').replace(/\s+/g, ' ').trim();
        const description_text = descText ? descText.slice(0, 6000) : null;
        const description_html = jsonLdJob.description_html || descHtml || null;

        const job = {
            url,
            title: jsonLdJob.title || titleDom,
            company: jsonLdJob.company || companyDom,
            location: jsonLdJob.location || locationDom,
            date_posted: jsonLdJob.date_posted || dateDom,
            description_html,
            description_text,
            source: 'infojobs',
            scraped_at: new Date().toISOString(),
        };

        await Actor.pushData(job);
        saved++;

        crawlerLog.info(
            `[DETAIL] Saved job #${saved}: ${job.title || '(no title)'}`,
        );
    }
});
