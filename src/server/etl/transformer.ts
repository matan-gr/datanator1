import sanitizeHtml from 'sanitize-html';
import { parseISO } from 'date-fns';
import type { RawFeedItem, DataSource } from './extractor.ts';

export interface TransformedItem {
  title: string;
  date: string;
  url: string;
  body: string;
  guid: string;
}

export function transformItems(items: RawFeedItem[], source: DataSource): TransformedItem[] {
  const seenGuids = new Set<string>();
  const transformed: TransformedItem[] = [];

  for (const item of items) {
    // 1. Deduplication (within this batch)
    if (!item.guid || seenGuids.has(item.guid)) continue;
    seenGuids.add(item.guid);

    let pubDate = new Date();
    if (item.pubDate) {
      const parsedDate = new Date(item.pubDate);
      if (!isNaN(parsedDate.getTime())) {
        pubDate = parsedDate;
      } else {
        const isoDate = parseISO(item.pubDate);
        if (!isNaN(isoDate.getTime())) {
          pubDate = isoDate;
        }
      }
    }

    // 2. Aggressive Sanitization
    const rawContent = item.content || item.contentSnippet || '';
    const cleanBody = sanitizeHtml(rawContent, {
      allowedTags: [], // Strip all HTML tags
      allowedAttributes: {},
      textFilter: (text) => text.replace(/\n+/g, '\n').trim()
    });

    transformed.push({
      title: item.title?.trim() || 'Untitled',
      date: pubDate.toISOString(),
      url: item.link || '',
      body: cleanBody,
      guid: item.guid
    });
  }

  return transformed;
}

export function formatDocument(items: TransformedItem[], source: DataSource, runId: string): string {
  const header = `\n\n=========================================\nSync Run: ${runId}\nDate: ${new Date().toISOString()}\nSource: ${source.name}\nNew Items: ${items.length}\n=========================================\n\n`;
  
  const body = items.map(item => `---
Title: ${item.title}
Date: ${item.date}
URL: ${item.url}

${item.body}
`).join('\n\n');

  return header + body;
}
