# InfoJobs Scraper

Discover and extract job listings from InfoJobs.net, Spain's leading job board. This powerful scraper automates the collection of job opportunities across various industries, locations, and categories.

## Overview

The InfoJobs Scraper is designed to efficiently gather job postings from InfoJobs.net. It supports keyword searches, location filtering, and comprehensive data extraction including job titles, company information, salaries, and detailed descriptions.

## Key Features

- **Comprehensive Job Data**: Extracts titles, companies, locations, salaries, contract types, and posting dates
- **Flexible Search Options**: Search by keywords, provinces, or specific URLs
- **Pagination Handling**: Automatically navigates through multiple result pages
- **Detail Extraction**: Optional deep scraping for full job descriptions
- **Structured Output**: Consistent JSON format for easy integration
- **SEO Optimized**: Enhanced for better discoverability on search engines

## Use Cases

- Job market analysis and research
- Recruitment data aggregation
- Career opportunity monitoring
- Employment trend tracking
- HR data collection

## Input Configuration

Configure your scraping job with the following parameters:

### Basic Search Parameters

- **Keyword**: Enter job-related terms (e.g., "ingeniero", "desarrollador", "marketing")
- **Location**: Specify province IDs (e.g., "28" for Madrid, "8" for Barcelona)
- **Category**: Optional category filter for more targeted results

### Advanced Options

- **Start URL**: Provide a direct InfoJobs search URL to begin scraping
- **Results Limit**: Set maximum number of jobs to collect (default: 100)
- **Page Limit**: Control maximum pages to scrape (default: 20)
- **Detail Collection**: Enable/disable detailed job description extraction

### Proxy and Cookies

- **Proxy Configuration**: Use residential proxies for reliable data collection
- **Custom Cookies**: Optional cookie settings for enhanced access

## Output Data Structure

Each scraped job includes:

```json
{
  "title": "Job Title",
  "company": "Company Name",
  "location": "City, Province",
  "salary": "?XX,XXX - ?YY,YYY Bruto/a�o",
  "job_type": "Contrato indefinido | Jornada completa",
  "date_posted": "Hace 2d",
  "description_html": "<p>Detailed job description...</p>",
  "description_text": "Plain text job description...",
  "url": "https://www.infojobs.net/job-url"
}
```

## Usage Examples

### Example 1: Basic Keyword Search

```json
{
  "keyword": "desarrollador software",
  "location": "28",
  "results_wanted": 50
}
```

### Example 2: Category-Specific Search

```json
{
  "keyword": "marketing digital",
  "category": "marketing",
  "collectDetails": true,
  "max_pages": 10
}
```

### Example 3: Custom URL Scraping

```json
{
  "startUrl": "https://www.infojobs.net/jobsearch/search-results/list.xhtml?keyword=ingeniero&provinceIds=28",
  "results_wanted": 100
}
```

## Getting Started

1. **Set Up Your Input**: Configure search parameters in the input schema
2. **Run the Scraper**: Execute on Apify platform or locally
3. **Access Results**: Retrieve structured job data from the dataset
4. **Integrate Data**: Use the JSON output in your applications

## Best Practices

- Use specific keywords for targeted results
- Set reasonable limits to avoid excessive data collection
- Enable proxy rotation for large-scale scraping
- Respect InfoJobs terms of service and rate limits
- Regularly update your scraping configuration

## Data Fields Explained

- **Title**: Job position name
- **Company**: Hiring organization
- **Location**: Job location (city/province)
- **Salary**: Compensation information when available
- **Job Type**: Contract type and working hours
- **Date Posted**: When the job was published
- **Description**: Detailed job requirements and responsibilities
- **URL**: Direct link to the original job posting

## Troubleshooting

### Common Issues

- **No Results Found**: Check keyword spelling and location codes
- **Incomplete Data**: Ensure detail collection is enabled
- **Rate Limiting**: Use proxy configuration and adjust concurrency

### Tips for Success

- Use province IDs from InfoJobs.net for accurate location filtering
- Combine multiple keywords with spaces for broader searches
- Monitor your usage to stay within platform limits

## Related Resources

- [InfoJobs.net](https://www.infojobs.net/) - Main job board website
- [Apify Platform](https://apify.com/) - Cloud scraping infrastructure
- [Crawlee Documentation](https://crawlee.dev/) - Web scraping framework

## Support

For questions or support, please refer to the Apify community forums or documentation.
