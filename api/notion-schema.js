// api/notion-schema.js
import { Client as NotionClient } from '@notionhq/client';

export default async function handler(req, res) {
  try {
    const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
    const subId = process.env.NOTION_SUBMISSIONS_DB_ID;
    const origId = process.env.NOTION_ORIGINALS_DB_ID;

    const out = {};
    if (subId) {
      const db = await notion.databases.retrieve({ database_id: subId });
      out.submissions = Object.fromEntries(
        Object.entries(db.properties).map(([k, v]) => [k, { type: v.type }])
      );
    }
    if (origId) {
      const db = await notion.databases.retrieve({ database_id: origId });
      out.originals = Object.fromEntries(
        Object.entries(db.properties).map(([k, v]) => [k, { type: v.type }])
      );
    }

    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
