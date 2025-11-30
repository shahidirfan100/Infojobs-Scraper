// InfoJobs Scraper - Hybrid (Playwright for SEO list pages, Cheerio + HTTP for detail pages)

import { Actor, log } from 'apify';
import { PlaywrightCrawler, CheerioCrawler } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        category = '',
        results_wanted: RESULTS_WANTED_RAW = 20,
        max_pages: MAX_PAGES_RAW = 5,
        startUrl,
        startUrls,
        url,
        proxyConfiguration,
        maxConcurrency: MAX_CONCURRENCY_INPUT, // for Playwright (list pages)
    } = input;

    const RESULTS_WANTED = Math.max(1, Number(RESULTS_WANTED_RAW) || 1);
    const MAX_PAGES = Math.max(1, Number(MAX_PAGES_RAW) || 1);

    const PLAYWRIGHT_MAX_CONCURRENCY = Math.min(
        Math.max(1, Number(MAX_CONCURRENCY_INPUT) || 2),
        3, // safe upper bound for Playwright
    );

    log.info(
        `Starting InfoJobs hybrid scraper - Target: ${RESULTS_WANTED} jobs, Max pages: ${MAX_PAGES}, Playwright concurrency: ${PLAYWRIGHT_MAX_CONCURRENCY}`,
    );

    // --------- INITIAL URLS (SEO LIST PAGES) ---------

    const initialUrls = [];
    if (Array.isArray(startUrls) && startUrls.length) initialUrls.push(...startUrls.map(String));
    if (startUrl) initialUrls.push(String(startUrl));
    if (url) initialUrls.push(String(url));

    if (!initialUrls.length) {
        initialUrls.push(buildSeoSearchUrl(keyword, location, category));
    }

    log.info(`Initial URLs: ${JSON.stringify(initialUrls, null, 2)}`);

    const proxyConf = await Actor.createProxyConfiguration(
        proxyConfiguration || { useApifyProxy: true },
    );

    // Shared state
    const detailUrlSet = new Set(); // URLs of individual jobs
    const visitedListPages = new Set();
    let saved = 0;

    /** @type {Array<{ name: string, value: string }>} */
    let sessionCookies = [];
    let userAgent = DEFAULT_UA;

    // ======================
    // 1) PLAYWRIGHT: SEO LIST PAGES ONLY
    // ======================

    const listCrawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: PLAYWRIGHT_MAX_CONCURRENCY,
        minConcurrency: 1,
        maxRequestRetries: 1,
        requestHandlerTimeoutSecs: 35,
        navigationTimeoutSecs: 25,
        maxRequestsPerCrawl: MAX_PAGES * 3 + 10,
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
                await page.setExtraHTTPHeaders({
                    'user-agent': DEFAULT_UA,
                    'accept-language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
                    accept:
                        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'upgrade-insecure-requests': '1',
                });

                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    // @ts-ignore
                    window.chrome = { runtime: {} };
                    Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es'] });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                });

                crawlerLog.debug(
                    `[LIST PRENAV] page=${request.userData.page || 1} url=${request.url}`,
                );
            },
        ],
        async requestHandler(ctx) {
            const { page, request, crawler, log: crawlerLog } = ctx;
            const currentPage = request.userData.page || 1;

            if (saved >= RESULTS_WANTED) {
                crawlerLog.info('[LIST] Global target reached, skipping navigation.');
                return;
            }

            if (visitedListPages.has(request.url)) {
                crawlerLog.debug(`[LIST] Already visited page: ${request.url}`);
                return;
            }
            visitedListPages.add(request.url);

            crawlerLog.info(
                `[LIST] Navigating to page ${currentPage}: ${request.url}`,
            );

            await page.goto(request.url, {
                waitUntil: 'domcontentloaded',
                timeout: 25000,
            });

            await page.waitForTimeout(400 + Math.random() * 400);
            await safeScroll(page, crawlerLog);

            // Capture cookies & UA once (for Cheerio detail phase)
            if (!sessionCookies.length) {
                try {
                    const cookies = await page.context().cookies();
                    if (cookies && cookies.length) {
                        sessionCookies = cookies;
                        crawlerLog.info(`[LIST] Collected ${cookies.length} cookies for detail phase.`);
                    }
                } catch (e) {
                    crawlerLog.warning(`[LIST] Failed to get cookies: ${e.message}`);
                }
            }

            if (userAgent === DEFAULT_UA) {
                try {
                    const ua = await page.evaluate(() => navigator.userAgent);
                    if (ua) {
                        userAgent = ua;
                        crawlerLog.info(`[LIST] Updated UA for detail phase: ${userAgent}`);
                    }
                } catch (e) {
                    crawlerLog.warning(`[LIST] Failed to read userAgent: ${e.message}`);
                }
            }

            // Wait for *some* job container (best-effort)
            await page
                .waitForSelector('a[href*="/of-"], [data-href*="/of-"], article, [data-test*="offer"]', {
                    timeout: 15000,
                })
                .catch(() => {});

            const jobLinks = await extractJobLinksFromPage(page, request.url, crawlerLog);
            crawlerLog.info(
                `[LIST] Page ${currentPage} => found ${jobLinks.length} job links.`,
            );

            for (const jobUrl of jobLinks) {
                if (detailUrlSet.size >= RESULTS_WANTED * 3) break; // reasonable overfetch
                if (detailUrlSet.has(jobUrl)) continue;
                detailUrlSet.add(jobUrl);
            }

            crawlerLog.info(
                `[LIST] Accumulated job URLs so far: ${detailUrlSet.size}`,
            );

            // Decide if we need more list pages
            if (
                detailUrlSet.size >= RESULTS_WANTED * 2 || // enough URLs + buffer
                currentPage >= MAX_PAGES
            ) {
                crawlerLog.info(
                    `[LIST] Stopping pagination. URLs=${detailUrlSet.size}, page=${currentPage}/${MAX_PAGES}`,
                );
                return;
            }

            const nextUrl = await findNextPageUrlPlaywright(page, request.url);
            if (!nextUrl || visitedListPages.has(nextUrl)) {
                crawlerLog.info('[PAGINATION] No next page URL found or already visited.');
                return;
            }

            await crawler.addRequests([
                {
                    url: nextUrl,
                    userData: { label: 'LIST', page: currentPage + 1 },
                },
            ]);

            crawlerLog.info(
                `[PAGINATION] Enqueued next list page: ${nextUrl} (page ${currentPage + 1})`,
            );
        },
        async failedRequestHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error(
                `[LIST FAILED] ${request.url} => ${error?.message}`,
            );
        },
    });

    const listStartingRequests = initialUrls.slice(0, MAX_PAGES).map((u) => ({
        url: u,
        userData: { label: 'LIST', page: 1 },
    }));

    // Run list-phase PlaywrightCrawler
    await listCrawler.run(listStartingRequests);

    log.info(
        `LIST phase finished. Collected ${detailUrlSet.size} unique job URLs. Cookies: ${sessionCookies.length}, UA: ${userAgent}`,
    );

    if (!detailUrlSet.size) {
        log.warning(
            'No job URLs collected from list pages. Exiting without detail scraping.',
        );
        return;
    }

    // ======================
    // 2) CHEERIO: DETAIL PAGES (HTTP only)
    // ======================

    const detailUrls = Array.from(detailUrlSet).slice(0, RESULTS_WANTED * 3); // overfetch buffer

    const detailRequests = detailUrls.map((u) => ({
        url: u,
        userData: { label: 'DETAIL' },
    }));

    const detailCrawler = new CheerioCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: 10,
        minConcurrency: 3,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 30,
        maxRequestsPerCrawl: detailRequests.length + 10,
        useSessionPool: false,
        preNavigationHooks: [
            async ({ request, log: crawlerLog }) => {
                request.headers ??= {};
                Object.assign(request.headers, buildHeaders(userAgent, sessionCookies));
                await sleep(80 + Math.random() * 230); // small jitter
                crawlerLog.debug(`[DETAIL PRENAV] ${request.url}`);
            },
        ],
        async requestHandler(ctx) {
            const { request, $, log: crawlerLog } = ctx;

            if (saved >= RESULTS_WANTED) {
                crawlerLog.info(
                    `[DETAIL] Global target reached (${saved} jobs). Skipping ${request.url}.`,
                );
                return;
            }

            if (!$) {
                crawlerLog.warning(
                    `[DETAIL] No DOM for ${request.url}, skipping.`,
                );
                return;
            }

            const html = $.html() || '';
            const text = $('body').text() || '';

            if (isBlockedDetail(html, text)) {
                crawlerLog.warning(
                    `[DETAIL][BLOCK] Block / bot-check detected on: ${request.url}`,
                );
                return;
            }

            crawlerLog.info(`[DETAIL] Extracting job from ${request.url}`);

            const job = extractJobFromDetailPage($, request.url);
            if (!job || !job.title) {
                crawlerLog.warning(
                    `[DETAIL] Failed to parse a valid job from ${request.url}`,
                );
                return;
            }

            // Second guard: check description for human/robot text
            const lowerDesc = (job.description_text || '').toLowerCase();
            if (
                lowerDesc.includes('¿eres humano o un robot?') ||
                lowerDesc.includes('eres humano o un robot') ||
                lowerDesc.includes('are you human or a robot')
            ) {
                crawlerLog.warning(
                    `[DETAIL][BLOCK] Human/robot check page detected in description, skipping: ${request.url}`,
                );
                return;
            }

            await Actor.pushData(job);
            saved++;

            crawlerLog.info(
                `[DETAIL] Saved job #${saved}: ${job.title || '(no title)'}`,
            );
        },
        async errorHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error(
                `[DETAIL ERROR] ${request.url} => ${error?.message}`,
            );
        },
    });

    await detailCrawler.run(detailRequests);

    log.info(`✓ Hybrid scraping finished. Total jobs saved: ${saved}`);

    // ======================
    // HELPER FUNCTIONS
    // ======================

    // Build SEO-friendly list URL rather than the protected /jobsearch/search-results/list.xhtml
    function buildSeoSearchUrl(keyword, location, category) {
        const base = 'https://www.infojobs.net/ofertas-trabajo';

        const kw = (keyword || '').trim();
        const loc = (location || '').trim();

        // Simple slugifier for keyword/location segments
        const slugify = (str) =>
            str
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || '';

        const kwSlug = kw ? slugify(kw) : '';
        const locSlug = loc ? slugify(loc) : '';

        // Some common patterns from the site:
        // /ofertas-trabajo/ingeniero
        // /ofertas-trabajo/madrid/ingeniero
        if (kwSlug && !locSlug) {
            return `${base}/${kwSlug}`;
        }

        if (kwSlug && locSlug) {
            return `${base}/${locSlug}/${kwSlug}`;
        }

        // Fallback: generic offers page
        return `${base}`;
    }

    function hasHumanRobotText(lower) {
        return (
            lower.includes('¿eres humano o un robot?') ||
            lower.includes('eres humano o un robot') ||
            lower.includes('are you human or a robot')
        );
    }

    // STRICT detection for DETAIL pages only
    function isBlockedDetail(html, text) {
        const lower = (text || '').toLowerCase();
        return (
            hasHumanRobotText(lower) ||
            lower.includes("we can't identify your browser") ||
            lower.includes('javascript is enabled') ||
            lower.includes('hemos detectado un uso inusual') ||
            ((html || '').length < 2500 &&
                lower.includes('javascript') &&
                lower.includes('browser'))
        );
    }

    function cookieHeader(cookies) {
        if (!cookies || !cookies.length) return undefined;
        return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    function buildHeaders(ua, cookies) {
        const headers = {
            'user-agent': ua || DEFAULT_UA,
            accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
            'upgrade-insecure-requests': '1',
        };
        const cookieStr = cookieHeader(cookies);
        if (cookieStr) headers.cookie = cookieStr;
        return headers;
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

    // 🔥 NEW: Much more robust link extraction on list pages
    async function extractJobLinksFromPage(page, baseUrl, logger) {
        const jobLinkPattern = /\/of-[a-z0-9]{5,}/i;

        const urls = await page.$$eval(
            'a, [data-href]',
            (els, patternStr) => {
                const pattern = new RegExp(patternStr, 'i');
                const out = new Set();

                for (const el of els) {
                    // Prefer href, fall back to data-href
                    let href =
                        (el.getAttribute && el.getAttribute('href')) ||
                        (el.getAttribute && el.getAttribute('data-href')) ||
                        '';

                    if (!href) continue;

                    // Ignore mailto/tel/javascript
                    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;

                    if (pattern.test(href)) {
                        out.add(href);
                    }
                }

                return Array.from(out);
            },
            jobLinkPattern.source,
        );

        let absUrls = urls
            .map((href) => toAbs(href, baseUrl))
            .filter((u) => typeof u === 'string');

        absUrls = Array.from(new Set(absUrls)); // dedupe

        if (!absUrls.length && logger) {
            // Debug: log first few anchors so we can inspect the DOM structure in logs
            const debugAnchors = await page.$$eval('a', (els) =>
                els.slice(0, 20).map((a) => ({
                    href: a.getAttribute('href'),
                    class: a.className,
                    txt: (a.textContent || '').trim().slice(0, 80),
                })),
            );
            logger.info(
                `[LIST DEBUG] No job links matched. First anchors: ${JSON.stringify(
                    debugAnchors,
                    null,
                    2,
                )}`,
            );
        }

        return absUrls;
    }

    async function findNextPageUrlPlaywright(page, currentUrl) {
        // Try pagination link with "Siguiente"
        const nextHref = await page
            .$eval(
                'a[aria-label*="iguiente"], a:has-text("Siguiente"), a:has-text("Siguiente >")',
                (a) => a.getAttribute('href') || '',
            )
            .catch(() => null);

        if (nextHref) {
            const abs = toAbs(nextHref, currentUrl);
            if (abs) return abs;
        }

        // Fallback: try ?page=2 style
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

    function parseJobFromJsonLd($) {
        try {
            const scripts = $('script[type="application/ld+json"]');
            const objs = [];

            scripts.each((_, el) => {
                const text = $(el).contents().text();
                if (!text) return;
                try {
                    const data = JSON.parse(text.trim());
                    if (Array.isArray(data)) objs.push(...data);
                    else objs.push(data);
                } catch {
                    // ignore
                }
            });

            if (!objs.length) return null;

            let job =
                objs.find((d) => d && d['@type'] === 'JobPosting') ||
                objs.find((d) => d && d['@type'] === 'Job') ||
                objs[0];

            if (!job) return null;

            const loc = job.jobLocation?.address;
            const location =
                loc?.addressLocality ||
                loc?.addressRegion ||
                loc?.addressCountry ||
                null;

            const hiringOrg = job.hiringOrganization;
            const company =
                (typeof hiringOrg === 'string'
                    ? hiringOrg
                    : hiringOrg?.name) || null;

            return {
                title: job.title || null,
                company,
                date_posted: job.datePosted || null,
                description_html: job.description || null,
                location,
            };
        } catch {
            return null;
        }
    }

    function extractJobFromDetailPage($, url) {
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
            $('[data-test="job-location"], .ij-Offer-info li:contains("ubicación"), .ij-Offer-info li:contains("Ubicación")')
                .first()
                .text()
                .trim() || null;

        const dateDom =
            $('[data-test="job-published"] time[datetime], time[datetime]')
                .first()
                .attr('datetime') || null;

        const descHtml =
            $('#jobDescription').html() ||
            $('.ij-Offer-description').html() ||
            $('article').html() ||
            null;

        let descText =
            $('#jobDescription').text().trim() ||
            $('.ij-Offer-description').text().trim() ||
            $('article').text().trim() ||
            $('body').text().trim() ||
            '';

        descText = descText.replace(/\s+/g, ' ').trim();

        const description_text = descText ? descText.slice(0, 6000) : null;
        const description_html = jsonLdJob.description_html || descHtml || null;

        return {
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
    }
});
