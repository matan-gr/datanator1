import Parser from 'rss-parser';
import crypto from 'crypto';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function createParser() {
  return new Parser({
    timeout: 60000, // 60 seconds to handle larger feeds
    customFields: {
      item: ['content:encoded', 'description', 'pubDate', 'updated', 'published']
    },
    headers: {
      'User-Agent': `${getRandomUserAgent()} GCP Datanator/0.9`,
      'Accept': 'application/rss+xml, application/rdf+xml, application/atom+xml, application/xml, text/xml, text/html, */*'
    }
  });
}

export interface RawFeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  content?: string;
  contentSnippet?: string;
  guid?: string;
  id?: string;
}

export interface DataSource {
  id: string;
  name: string;
  url: string;
  type: 'rss' | 'atom' | 'json';
}

export const DATA_SOURCES: DataSource[] = [
  { id: 'cloud-blog-main', name: 'Cloud Blog - Main', url: 'https://cloudblog.withgoogle.com/rss/', type: 'rss' },
  { id: 'medium-blog', name: 'Medium Blog', url: 'https://medium.com/feed/google-cloud', type: 'rss' },
  { id: 'cloud-innovation', name: 'Google Cloud Innovation', url: 'https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/rss/', type: 'rss' },
  { id: 'ai-technology', name: 'Google AI Technology', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', type: 'rss' },
  { id: 'release-notes', name: 'Release Notes & Deprecations', url: 'https://cloud.google.com/feeds/gcp-release-notes.xml', type: 'rss' },
  { id: 'ai-research', name: 'Google AI Research', url: 'http://googleaiblog.blogspot.com/atom.xml?max-results=1000', type: 'atom' },
  { id: 'gemini-workspace', name: 'Gemini & Workspace', url: 'https://workspaceupdates.googleblog.com/feeds/posts/default?max-results=1000', type: 'atom' },
  { id: 'service-health', name: 'Service Health (Incidents)', url: 'https://status.cloud.google.com/feed.atom', type: 'atom' },
  { id: 'security-bulletins', name: 'Security Bulletins', url: 'https://cloud.google.com/feeds/google-cloud-security-bulletins.xml', type: 'rss' },
  { id: 'terraform-provider', name: 'Terraform Provider (IaC Releases)', url: 'https://github.com/hashicorp/terraform-provider-google/releases.atom', type: 'atom' }
];

export interface ExtractResult {
  items: RawFeedItem[];
  status: number;
  statusText: string;
  url: string;
  duration: number;
}

export async function extractFeed(source: DataSource, retries = 3): Promise<ExtractResult> {
  // Add random jitter (0-2000ms) to prevent thundering herd and rate limits
  const jitter = Math.floor(Math.random() * 2000);
  await new Promise(resolve => setTimeout(resolve, jitter));

  let lastError: Error | null = null;
  let lastStatus = 0;
  let lastStatusText = '';
  let duration = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.debug(`Starting extraction for source: ${source.name} (${source.url}) - Attempt ${attempt}/${retries}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      
      const startTime = Date.now();
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': `${getRandomUserAgent()} GCP Datanator/0.9`,
          'Accept': 'application/rss+xml, application/rdf+xml, application/atom+xml, application/xml, text/xml, text/html, */*'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      duration = Date.now() - startTime;
      
      lastStatus = response.status;
      lastStatusText = response.statusText;

      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      const parser = createParser();
      const feed = await parser.parseString(text);
      
      console.debug(`Fetched ${feed.items.length} total items from ${source.name}.`);

      const items = feed.items
        .filter(item => item.title || item.content || item.description || item['content:encoded'])
        .map(item => {
        // Generate a deterministic GUID if one is not provided by the feed
        // We use link primarily, fallback to title, to avoid duplicates if pubDate changes
        const uniqueString = item.link ? item.link : (item.title || '');
        const deterministicGuid = crypto.createHash('sha256')
          .update(uniqueString)
          .digest('hex');
          
        return {
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || item.updated || item.published,
          content: item['content:encoded'] || item.content || item.description,
          contentSnippet: item.contentSnippet,
          guid: item.guid || (item as any).id || deterministicGuid
        };
      });

      return {
        items,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        duration
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Attempt ${attempt} failed to extract feed ${source.name}:`, error);
      if (attempt === retries) {
        throw new Error(`Failed to extract feed ${source.name} after ${retries} attempts: HTTP ${lastStatus} ${lastStatusText} - ${lastError.message}`);
      }
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
  return { items: [], status: lastStatus, statusText: lastStatusText, url: source.url, duration };
}
