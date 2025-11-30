// InfoJobs Scraper - Hybrid approach (Playwright for handshake + Cheerio for speed)
import { Actor, log } from 'apify';
import { PlaywrightCrawler, CheerioCrawler } from 'crawlee';

const DEFAULT_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.init();

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        category = '',
        results_wanted: RESULTS_WANTED_RAW = 100,
        max_pages: MAX_PAGES_RAW = 20,
        collectDetails = true,
        startUrl,
        startUrls,
        url,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Math.max(1, Number(RESULTS_WANTED_RAW) || 1);
    const MAX_PAGES = Math.max(1, Number(MAX_PAGES_RAW) || 1);

    log.info(`Starting InfoJobs scraper - Target: ${RESULTS_WANTED} jobs, Max pages: ${MAX_PAGES}`);

    // Build initial URLs
    const initialUrls = [];
    if (Array.isArray(startUrls) && startUrls.length) initialUrls.push(...startUrls.map(String));
    if (startUrl) initialUrls.push(String(startUrl));
    if (url) initialUrls.push(String(url));
    if (!initialUrls.length) initialUrls.push(buildSearchUrl(keyword, location, category));

    log.info(`Initial URLs: ${JSON.stringify(initialUrls, null, 2)}`);

    const proxyConf = await Actor.createProxyConfiguration(
        proxyConfiguration || { useApifyProxy: true },
    );

    let saved = 0;
    const seenUrls = new Set();
    /** @type {Array<{ name: string, value: string, domain?: string, path?: string }>} */
    let sessionCookies = [];
    let userAgent = DEFAULT_UA;
    let handshakeAttempts = 0;
    const MAX_HANDSHAKE_ATTEMPTS = 3;

    // --- HANDSHAKE: Playwright to acquire cookies & UA ---

    await acquireSessionCookies(initialUrls[0], 'initial');

    if (!sessionCookies.length) {
        log.warning('[HANDSHAKE] No cookies after initial handshake – continuing without cookies (site may still work).');
    }

    // --- MAIN CRAWLER: Cheerio for speed & low cost ---

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 6,
        minConcurrency: 2,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 45,
        // Hard cap: prevent runaway crawls
        maxRequestsPerCrawl: Math.min(
            RESULTS_WANTED * 3 + 50,
            MAX_PAGES * 50,
            5000,
        ),
        preNavigationHooks: [
            async ({ request, log: crawlerLog }) => {
                // Inject headers & cookies into EVERY HTTP request
                request.headers ??= {};
                Object.assign(request.headers, buildHeaders(userAgent, sessionCookies));
                crawlerLog.debug(`[PRENAV] ${request.url}`);
            },
        ],
        async requestHandler(ctx) {
            const { request, $, log: crawlerLog } = ctx;
            const label = request.userData.label || 'LIST';

            if (!$) {
                crawlerLog.warning(`[${label}] No DOM object ($) for ${request.url}, skipping.`);
                return;
            }

            const html = $.html() || '';
            const text = $('body').text() || '';

            if (isBlocked(html, text)) {
                crawlerLog.warning(`[BLOCK] Detected block on ${label} page: ${request.url}`);
                await handleBlockReHandshake(ctx);
                return;
            }

            if (label === 'DETAIL') {
                await handleDetailPage(ctx);
                return;
            }

            // LIST page logic
            if (saved >= RESULTS_WANTED) {
                crawlerLog.info('[LIST] Target already reached, skipping further crawling.');
                return;
            }

            const links = findJobLinks($, request.url, seenUrls);
            crawlerLog.info(`[LIST] Found ${links.length} potential job links on ${request.url}`);

            for (const jobUrl of links) {
                if (saved >= RESULTS_WANTED) break;
                if (seenUrls.has(jobUrl)) continue;
                seenUrls.add(jobUrl);

                if (collectDetails) {
                    await ctx.crawler.addRequests([{
                        url: jobUrl,
                        userData: { label: 'DETAIL' },
                    }]);
                } else {
                    await Actor.pushData({ url: jobUrl, source: 'infojobs' });
                    saved++;
                }
            }

            if (saved >= RESULTS_WANTED) {
                crawlerLog.info('[LIST] Reached target jobs – not enqueueing next pages.');
                return;
            }

            const currentPage = request.userData.page || 1;
            if (currentPage >= MAX_PAGES) {
                crawlerLog.info(`[LIST] Reached MAX_PAGES (${MAX_PAGES}), stopping pagination.`);
                return;
            }

            const nextUrl = findNextPageUrl($, request.url);
            if (nextUrl && !seenUrls.has(nextUrl)) {
                seenUrls.add(nextUrl);
                await ctx.crawler.addRequests([{
                    url: nextUrl,
                    userData: { label: 'LIST', page: currentPage + 1 },
                }]);
                crawlerLog.info(`[PAGINATION] Enqueued next page: ${nextUrl} (page ${currentPage + 1})`);
            } else {
                crawlerLog.info('[PAGINATION] No next page found.');
            }
        },
        async errorHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error(`[ERROR] ${request.url} failed: ${error?.message}`);
        },
    });

    const startingRequests = initialUrls.slice(0, MAX_PAGES).map((u) => ({
        url: u,
        userData: { label: 'LIST', page: 1 },
    }));

    await crawler.run(startingRequests);

    log.info(`✓ Scraping finished. Total jobs saved: ${saved}`);

    // ------------- HELPER FUNCTIONS (IN-SCOPE) -------------

    /**
     * Build InfoJobs search URL from keyword/location/category
     */
    function buildSearchUrl(keyword, location, category) {
        const url = new URL('https://www.infojobs.net/jobsearch/search-results/list.xhtml');
        if (keyword) url.searchParams.set('keyword', String(keyword));
        if (location) url.searchParams.set('provincia', String(location));
        if (category) url.searchParams.set('category', String(category));
        url.searchParams.set('sortBy', 'PUBLICATION_DATE');
        url.searchParams.set('page', '1');
        return url.href;
    }

    function cookieHeader(cookies) {
        if (!cookies || !cookies.length) return undefined;
        return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    function buildHeaders(ua, cookies) {
        const headers = {
            'user-agent': ua || DEFAULT_UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
            'upgrade-insecure-requests': '1',
        };
        const cookieStr = cookieHeader(cookies);
        if (cookieStr) headers.cookie = cookieStr;
        return headers;
    }

    function isBlocked(html, text) {
        const lower = (text || '').toLowerCase();
        return (
            lower.includes("we can't identify your browser") ||
            lower.includes('javascript is enabled') ||
            lower.includes('hemos detectado un uso inusual') ||
            (
                (html || '').length < 2500 &&
                lower.includes('javascript') &&
                lower.includes('browser')
            )
        );
    }

    function toAbs(href, base) {
        try {
            return new URL(href, base).href;
        } catch {
            return null;
        }
    }

    function findJobLinks($, base, seen) {
        const links = new Set();

        const selectors = [
            'h2 a[href*="/of-i"]',
            'a.ij-OfferCard-title-link[href*="/of-i"]',
            'a[href*="/of-i"]',
        ];

        for (const sel of selectors) {
            $(sel).each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                if (!/\/of-i[a-z0-9]/i.test(href)) return;
                const abs = toAbs(href, base);
                if (abs && !seen.has(abs)) links.add(abs);
            });
            if (links.size >= 10) break; // good enough; avoid over-enqueueing weird URLs
        }

        return Array.from(links);
    }

    function findNextPageUrl($, base) {
        try {
            let nextHref =
                $('a[aria-label*="iguiente"], a:contains("Siguiente")')
                    .filter((_, el) => $(el).is('a'))
                    .first()
                    .attr('href') || null;

            if (nextHref) {
                const abs = toAbs(nextHref, base);
                if (abs) return abs;
            }

            const url = new URL(base);
            const currentPage = parseInt(url.searchParams.get('page') || '1', 10);
            const nextPage = currentPage + 1;
            url.searchParams.set('page', String(nextPage));
            return url.href;
        } catch (e) {
            log.error(`[PAGINATION] Error computing next page from ${base}: ${e.message}`);
            return null;
        }
    }

    function parseJobFromJsonLd($) {
        try {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                const text = $(scripts[i]).contents().text();
                if (!text) continue;
                let data = JSON.parse(text.trim());

                if (Array.isArray(data)) {
                    data = data.find((d) => d['@type'] === 'JobPosting') || data[0];
                }

                if (!data) continue;
                if (!(data['@type'] === 'JobPosting' || data.title || data.description)) continue;

                const loc = data.jobLocation?.address;
                const location =
                    loc?.addressLocality ||
                    loc?.addressRegion ||
                    loc?.addressCountry ||
                    null;

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
        } catch {
            // ignore JSON-LD parse errors
        }
        return null;
    }

    async function handleDetailPage(ctx) {
        const { request, $, log: crawlerLog } = ctx;

        if (saved >= RESULTS_WANTED) {
            crawlerLog.debug('[DETAIL] Target already reached, skipping.');
            return;
        }

        const url = request.url;
        crawlerLog.info(`[DETAIL] Extracting job from ${url}`);

        const html = $.html() || '';
        const text = $('body').text() || '';

        if (isBlocked(html, text)) {
            crawlerLog.warning(`[DETAIL][BLOCK] Detected block on detail page: ${url}`);
            await handleBlockReHandshake(ctx);
            return;
        }

        const jsonLdJob = parseJobFromJsonLd($) || {};

        const titleDom =
            $('h1').first().text().trim() ||
            $('meta[property="og:title"]').attr('content') ||
            null;

        const companyDom =
            $('[data-test="job-company"], .ij-Offer-info h3, .js-LogoAndName-companyName')
                .first()
                .text()
                .trim() || null;

        const locationDom =
            $('[data-test="job-location"], .ij-Offer-info li:contains("ubicación")')
                .first()
                .text()
                .trim() || null;

        const dateDom =
            $('[data-test="job-published"], time[datetime]')
                .first()
                .attr('datetime') || null;

        const descHtml =
            $('#jobDescription').html() ||
            $('.ij-Offer-description').html() ||
            $('article').html() ||
            null;

        const descText =
            $('#jobDescription').text().trim() ||
            $('.ij-Offer-description').text().trim() ||
            $('article').text().trim() ||
            $('body').text().trim() ||
            '';

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

        crawlerLog.info(`[DETAIL] Saved job #${saved}: ${job.title || '(no title)'}`);
    }

    async function handleBlockReHandshake(ctx) {
        const { request, crawler } = ctx;

        if (request.userData.retriedAfterBlock) {
            log.warning('[BLOCK] Request already retried after block, skipping re-enqueue.');
            return;
        }

        if (handshakeAttempts >= MAX_HANDSHAKE_ATTEMPTS) {
            log.warning('[BLOCK] Max handshake attempts reached, not re-handshaking.');
            return;
        }

        await acquireSessionCookies(request.url, 'block-detection');

        if (sessionCookies.length) {
            log.info('[BLOCK] New cookies acquired, re-enqueueing blocked request once.');
            await crawler.addRequests([{
                url: request.url,
                userData: {
                    ...request.userData,
                    retriedAfterBlock: true,
                },
            }]);
        } else {
            log.warning('[BLOCK] Still no cookies after re-handshake; giving up on this request.');
        }
    }

    async function acquireSessionCookies(startUrlForHandshake, reason = 'initial') {
        if (!startUrlForHandshake) {
            log.warning('[HANDSHAKE] No URL provided for handshake.');
            return;
        }

        if (handshakeAttempts >= MAX_HANDSHAKE_ATTEMPTS) {
            log.warning(`[HANDSHAKE] Max attempts (${MAX_HANDSHAKE_ATTEMPTS}) reached, skipping.`);
            return;
        }

        handshakeAttempts++;
        log.info(
            `[HANDSHAKE] Attempt #${handshakeAttempts} (${reason}) using URL: ${startUrlForHandshake}`,
        );

        const handshakeCrawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,
            maxRequestsPerCrawl: 1,
            maxRequestRetries: 1,
            maxConcurrency: 1,
            requestHandlerTimeoutSecs: 60,
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
                contextOptions: {
                    userAgent,
                    viewport: { width: 1920, height: 1080 },
                    locale: 'es-ES',
                },
            },
            preNavigationHooks: [
                async ({ page }) => {
                    await page.setExtraHTTPHeaders({
                        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
                        'upgrade-insecure-requests': '1',
                    });

                    // Stealth-ish tweaks (Playwright version-safe: use addInitScript instead of evaluateOnNewDocument)
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
                },
            ],
            async requestHandler({ page, request, log: crawlerLog }) {
                crawlerLog.info(`[HANDSHAKE] Opening ${request.url}`);
                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });

                await page.waitForSelector('body', { timeout: 30000 }).catch(() => {});

                await sleep(1500 + Math.random() * 1500);
                await page
                    .evaluate(() => window.scrollTo(0, 600))
                    .catch(() => {});
                await sleep(500 + Math.random() * 500);

                const cookies = await page.context().cookies();
                if (!cookies || !cookies.length) {
                    crawlerLog.warning('[HANDSHAKE] No cookies found in context');
                } else {
                    sessionCookies = cookies;
                    crawlerLog.info(`[HANDSHAKE] Collected ${cookies.length} cookies.`);
                }

                try {
                    const ua = await page.evaluate(() => navigator.userAgent);
                    if (ua) {
                        userAgent = ua;
                        crawlerLog.info(`[HANDSHAKE] Updated UA: ${userAgent}`);
                    }
                } catch (e) {
                    crawlerLog.warning(
                        `[HANDSHAKE] Unable to get userAgent: ${e.message}`,
                    );
                }
            },
            failedRequestHandler({ request, error, log: crawlerLog }) {
                crawlerLog.error(
                    `[HANDSHAKE] Failed request ${request.url}: ${error?.message}`,
                );
            },
        });

        try {
            await handshakeCrawler.run([{ url: startUrlForHandshake }]);
        } catch (e) {
            log.error(`[HANDSHAKE] Crawler run crashed: ${e.message}`);
        }
    }
});
