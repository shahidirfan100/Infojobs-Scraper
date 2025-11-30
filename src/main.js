// InfoJobs Scraper - Hybrid approach (Playwright for handshake + Cheerio for speed)
import { Actor, log } from 'apify';
import { PlaywrightCrawler, CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

await Actor.init();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        log.info(`Starting InfoJobs scraper - Target: ${RESULTS_WANTED} jobs, Max pages: ${MAX_PAGES}`);

        const toAbs = (href, base = 'https://www.infojobs.net') => {
            try {
                if (!href) return null;
                if (href.startsWith('http')) return href;
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.infojobs.net/jobsearch/search-results/list.xhtml');
            if (kw) u.searchParams.set('keyword', String(kw).trim());
            if (loc) u.searchParams.set('provinceIds', String(loc).trim());
            if (cat) u.searchParams.set('category', String(cat).trim());
            u.searchParams.set('sortBy', 'PUBLICATION_DATE');
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;
        const seenUrls = new Set();
        let sessionCookies = null;
        let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        // Function to get cookies using Playwright (one-time handshake)
        async function acquireSessionCookies() {
            log.info('Starting Playwright handshake to acquire cookies...');
            
            const handshakeCrawler = new PlaywrightCrawler({
                proxyConfiguration: proxyConf,
                maxRequestRetries: 3,
                maxConcurrency: 1,
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
                    async ({ page, session }) => {
                        // Set realistic headers
                        await page.setExtraHTTPHeaders({
                            'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'DNT': '1',
                            'Sec-Fetch-Dest': 'document',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-Site': 'none',
                            'Sec-Fetch-User': '?1',
                            'Upgrade-Insecure-Requests': '1',
                        });
                        
                        // Set realistic viewport
                        await page.setViewport({ width: 1920, height: 1080 });
                        
                        // Enhanced stealth: Add init script to remove webdriver
                        await page.addInitScript(() => {
                            Object.defineProperty(navigator, 'webdriver', {
                                get: () => undefined,
                            });
                            
                            // Mock chrome runtime
                            window.chrome = { runtime: {} };
                            
                            // Mock permissions
                            const originalQuery = window.navigator.permissions.query;
                            window.navigator.permissions.query = (parameters) => (
                                parameters.name === 'notifications' ?
                                    Promise.resolve({ state: Notification.permission }) :
                                    originalQuery(parameters)
                            );
                        });
                    },
                ],
                async requestHandler({ page, request }) {
                    log.info(`Playwright handshake: Loading ${request.url}`);
                    
                    // Wait for page to load completely
                    await page.waitForSelector('body', { timeout: 30000 });
                    
                    // Simulate human behavior with random delays
                    await sleep(1500 + Math.random() * 1500);
                    
                    // Optional: Scroll a bit to trigger lazy loading
                    await page.evaluate(() => window.scrollTo(0, 500));
                    await sleep(500);
                    
                    // Get cookies from browser
                    const cookies = await page.context().cookies();
                    sessionCookies = cookies;
                    
                    // Get user agent
                    userAgent = await page.evaluate(() => navigator.userAgent);
                    
                    log.info(`✓ Acquired ${cookies.length} cookies from InfoJobs`);
                    log.info(`✓ User-Agent: ${userAgent}`);
                },
            });
            
            // Run handshake on the first URL only
            const handshakeUrl = initial[0];
            await handshakeCrawler.run([handshakeUrl]);
            
            return sessionCookies;
        }

        // Enhanced detail extraction
        function extractJobDetails($, url) {
            try {
                const data = {};

                // Extract from JSON-LD if available
                const jsonLd = extractFromJsonLd($);
                if (jsonLd) {
                    Object.assign(data, jsonLd);
                }

                // Title: multiple selectors
                if (!data.title) {
                    data.title = $('h1').first().text().trim() ||
                        $('h2').first().text().trim() ||
                        $('[class*="title"]').first().text().trim() ||
                        null;
                }

                // Company: look for h3, company class, or link to company pages
                if (!data.company) {
                    data.company = $('h3').first().text().trim() ||
                        $('a[href*="/em-i"]').first().text().trim() ||
                        $('[class*="company"]').first().text().trim() ||
                        null;
                }

                // Location: look for text with city names or pipe separator
                if (!data.location) {
                    const locationText = $('*').filter((_, el) => {
                        const text = $(el).text();
                        return /\|.*\|/i.test(text) && text.length < 100;
                    }).first().text().trim();
                    
                    if (locationText) {
                        const parts = locationText.split('|').map(p => p.trim());
                        data.location = parts[0] || null;
                    }
                }

                // Salary: look for € or "Bruto"
                data.salary = $('*').filter((_, el) => {
                    const text = $(el).text();
                    return /€|bruto/i.test(text) && text.length < 100;
                }).first().text().trim() || null;

                // Job type: contract and workday info
                const contractInfo = $('*').filter((_, el) => {
                    const text = $(el).text();
                    return /(contrato|jornada)/i.test(text) && text.length < 200;
                }).first().text().trim();
                
                if (contractInfo) {
                    const parts = contractInfo.split('|').map(p => p.trim());
                    data.job_type = parts.filter(p => p.length > 0).join(' | ') || null;
                }

                // Date posted
                data.date_posted = $('*').filter((_, el) => {
                    const text = $(el).text();
                    return /hace.*\d|publicada/i.test(text) && text.length < 50;
                }).first().text().trim() || null;

                // Description: look for larger text blocks
                if (!data.description_html) {
                    const descEl = $('[class*="description"], [class*="content"], div').filter((_, el) => {
                        return $(el).text().length > 100;
                    }).first();
                    
                    if (descEl.length) {
                        data.description_html = descEl.html().trim();
                        data.description_text = cleanText(data.description_html);
                    }
                }

                return data;
            } catch (err) {
                log.error(`Error extracting job details: ${err.message}`);
                return {};
            }
        }

        function extractFromJsonLd($) {
            try {
                const scripts = $('script[type="application/ld+json"]');
                for (let i = 0; i < scripts.length; i++) {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address &&
                                    (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                            };
                        }
                    }
                }
            } catch (err) {
                // Ignore JSON-LD parsing errors
            }
            return null;
        }

        // Enhanced job link finder - InfoJobs uses /of-i[hash]/ pattern
        function findJobLinks($, base) {
            const links = new Set();
            
            // Primary selector: h2 headers with job title links
            $('h2 a[href*="/of-i"]').each((_, el) => {
                const href = $(el).attr('href');
                if (href && /\/of-i[a-z0-9]+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !seenUrls.has(abs)) {
                        links.add(abs);
                        seenUrls.add(abs);
                    }
                }
            });

            // Backup: all links matching pattern
            $('a[href*="/of-i"]').each((_, el) => {
                const href = $(el).attr('href');
                if (href && /\/of-i[a-z0-9]+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !seenUrls.has(abs)) {
                        links.add(abs);
                        seenUrls.add(abs);
                    }
                }
            });

            return [...links];
        }

        // Enhanced pagination finder
        function findNextPage($, base) {
            try {
                // Look for pagination with "Siguiente" or page numbers
                const nextLink = $('a[aria-label*="siguiente"], a:contains("Siguiente")').first().attr('href');
                if (nextLink) {
                    const abs = toAbs(nextLink, base);
                    log.info(`Found next page via Siguiente link: ${abs}`);
                    return abs;
                }

                // Parse current page from URL and increment
                const currentUrl = new URL(base);
                const currentPage = parseInt(currentUrl.searchParams.get('page') || '1');
                const nextPageUrl = new URL(base);
                nextPageUrl.searchParams.set('page', (currentPage + 1).toString());
                log.info(`Generated next page URL: ${nextPageUrl.href}`);
                return nextPageUrl.href;
            } catch (err) {
                log.error(`Error finding next page: ${err.message}`);
                return null;
            }
        }

        // Acquire cookies using Playwright handshake (one-time only)
        await acquireSessionCookies();
        
        if (!sessionCookies || sessionCookies.length === 0) {
            throw new Error('Failed to acquire session cookies from Playwright handshake');
        }
        
        log.info('Cookie handshake complete. Switching to fast CheerioCrawler with got-scraping...');
        
        // Build cookie string for got-scraping
        const cookieString = sessionCookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        // Use fast CheerioCrawler with acquired cookies
        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            useSessionPool: false, // We manage cookies manually
            maxConcurrency: 10,
            minConcurrency: 4,
            requestHandlerTimeoutSecs: 60,
            maxRequestsPerCrawl: MAX_PAGES * 30 + 100,
            
            // Use got-scraping with cookies from Playwright
            preNavigationHooks: [
                async ({ request }) => {
                    // Random delay between requests for stealth (100-500ms)
                    await sleep(100 + Math.random() * 400);
                    
                    // Add cookies and realistic headers to every request
                    request.headers = {
                        ...request.headers,
                        'Cookie': cookieString,
                        'User-Agent': userAgent,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'DNT': '1',
                        'Upgrade-Insecure-Requests': '1',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-User': '?1',
                        'Cache-Control': 'max-age=0',
                        'Referer': 'https://www.infojobs.net/',
                    };
                },
            ],

            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                
                // Check if we got blocked (bot detection page)
                const bodyText = $.text();
                if (bodyText.includes('We can\'t identify your browser') || bodyText.includes('JavaScript is enabled')) {
                    crawlerLog.warning(`⚠️ Bot detection page detected at ${request.url}`);
                    // Re-acquire cookies if blocked
                    log.info('🔄 Re-acquiring cookies due to bot detection...');
                    await acquireSessionCookies();
                    const newCookieString = sessionCookies.map(c => `${c.name}=${c.value}`).join('; ');
                    // Update cookie string for subsequent requests
                    request.headers['Cookie'] = newCookieString;
                    throw new Error('Bot detection - cookies refreshed, retrying');
                }

                if (label === 'LIST') {
                    crawlerLog.info(`Processing LIST page ${pageNo}: ${request.url}`);
                    
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`Found ${links.length} job links on page ${pageNo}`);

                    if (links.length === 0) {
                        crawlerLog.warning(`No job links found on page ${pageNo}. Page might be blocked or empty.`);
                    }

                    if (collectDetails && links.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            await enqueueLinks({
                                urls: toEnqueue,
                                userData: { label: 'DETAIL' },
                            });
                            crawlerLog.info(`Enqueued ${toEnqueue.length} detail pages`);
                        }
                    } else if (!collectDetails && links.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            await Dataset.pushData(
                                toPush.map((u) => ({ url: u, _source: 'infojobs.net' }))
                            );
                            saved += toPush.length;
                            crawlerLog.info(`Saved ${toPush.length} URLs (total: ${saved})`);
                        }
                    }

                    // Pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url);
                        if (next) {
                            await enqueueLinks({
                                urls: [next],
                                userData: { label: 'LIST', pageNo: pageNo + 1 },
                            });
                            crawlerLog.info(`Moving to page ${pageNo + 1}`);
                        } else {
                            crawlerLog.info('No more pages found');
                        }
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`Reached target of ${RESULTS_WANTED} jobs, skipping`);
                        return;
                    }

                    try {
                        crawlerLog.info(`Processing DETAIL: ${request.url}`);
                        
                        const data = extractJobDetails($, request.url);

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: category || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job #${saved}: ${item.title || 'Unknown'}`);
                    } catch (err) {
                        crawlerLog.error(`Failed to process ${request.url}: ${err.message}`);
                    }
                }
            },

            async failedRequestHandler({ request }, error) {
                log.error(`Request ${request.url} failed: ${error.message}`);
            },
        });

        log.info(`Starting crawler with ${initial.length} initial URL(s)`);
        await crawler.run(initial.map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        
        log.info(`✓ Scraping completed! Total jobs saved: ${saved}`);
    } catch (error) {
        log.error(`Fatal error: ${error.message}`);
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
