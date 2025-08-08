// api/notion-schema.js
import { Client as NotionClient } from '@notionhq/client';

export default async function handler(req, res) {
  try {
    const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
    const subId = process.env.NOTION_SUBMISSIONS_DB_ID;
    if (!subId) return res.status(400).json({ error: 'NOTION_SUBMISSIONS_DB_ID missing' });

    const db = await notion.databases.retrieve({ database_id: subId });
    const props = Object.fromEntries(
      Object.entries(db.properties).map(([k, v]) => [k, { type: v.type }])
    );

    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.status(200).json({ submissions: props });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
