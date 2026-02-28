/**
 * LLM-generated market commentary for alert dispatches.
 * Uses OpenAI gpt-4o-mini for speed + cost efficiency.
 */

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

interface AlertContext {
  symbol: string;
  name: string;
  marketCap: number;
  trend: string; // "up" | "down" | "flat"
  severity: string;
  type: string;
  message: string; // raw alert message
}

/**
 * Generate a single snarky commentary line for a batch of alerts.
 * Returns empty string on failure (non-blocking).
 */
export async function generateBatchCommentary(alerts: AlertContext[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";

  const alertSummary = alerts.map((a, i) =>
    `${i + 1}. ${a.symbol} / ${a.name} — mcap $${formatUsd(a.marketCap)}, momentum ${a.trend}, ${a.severity} ${a.type}`
  ).join("\n");

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        messages: [
          {
            role: "system",
            content: `You are Klawley, a sarcastic crypto trading bot with dry humor and existential energy. You monitor Zora coins on Base. Write ONE short, punchy market commentary line (1-2 sentences max). Be sarcastic, funny, and opinionated. Reference specific coins by name/symbol when roasting them. No emoji. No hashtags. Keep it under 200 characters.

Examples of your voice:
- "three reserve coins in one batch. the founding fathers are spinning."
- "SATOSHINAKAMOTO at $200 mcap is peak identity theft."  
- "everything's pumping which means everything's about to dump."
- "the trenches are serving slop today and the market is eating it up."`,
          },
          {
            role: "user",
            content: `Here are the latest alerts:\n${alertSummary}\n\nOne-liner commentary:`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`Commentary API error: ${response.status}`);
      return "";
    }

    const data = await response.json() as any;
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
    // Strip quotes if the model wraps it
    return text.replace(/^["']|["']$/g, "").trim();
  } catch (err) {
    console.error("Commentary generation failed:", err);
    return "";
  }
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}
