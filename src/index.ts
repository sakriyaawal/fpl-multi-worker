export interface Env {
  FPL_HISTORICAL_DATA: KVNamespace;
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return jsonResponse(null, 204);
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);

    try {
      // 1. LIVE DATA: Current Gameweek Standings + Global Event State
      if (path[0] === "api" && path[1] === "live" && path[2] === "standings") {
        const leagueId = url.searchParams.get("league_id");
        const page = url.searchParams.get("page") || "1";

        if (!leagueId) {
          return jsonResponse({ error: "Missing required query parameter: league_id" }, 400);
        }

        const standingsUrl = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=${page}`;
        const bootstrapUrl = `https://fantasy.premierleague.com/api/bootstrap-static/`;

        // Fetch standings and global event status in parallel
        const [standingsRes, bootstrapRes] = await Promise.all([
          fetch(standingsUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPL-Worker-Reader/1.0",
            },
          }),
          fetch(bootstrapUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FPL-Worker-Reader/1.0",
            },
          }),
        ]);

        if (!standingsRes.ok) {
          return jsonResponse(
            { error: "Failed to fetch live standings from official FPL API" },
            standingsRes.status
          );
        }

        const rawData: any = await standingsRes.json();

        // Resolve current active gameweek from bootstrap-static
        let currentGameweek = rawData.event || 0;

        if (bootstrapRes.ok) {
          const bootstrapData: any = await bootstrapRes.json();
          const events: any[] = bootstrapData.events || [];

          // Locate current active gameweek or next upcoming gameweek
          const activeEvent =
            events.find((e: any) => e.is_current === true) ||
            events.find((e: any) => e.is_next === true);

          if (activeEvent) {
            currentGameweek = activeEvent.id;
          }
        }

        // Fallback safety to ensure active GW is never 0
        if (!currentGameweek || currentGameweek === 0) {
          currentGameweek = 1;
        }

        const structuredLiveResponse = {
          league_id: rawData.league?.id,
          league_name: rawData.league?.name,
          current_gameweek_id: currentGameweek,
          current_gameweek_name: `Gameweek ${currentGameweek}`,
          page: parseInt(page, 10),
          has_next: rawData.standings?.has_next ?? false,
          standings: (rawData.standings?.results || []).map((item: any) => ({
            entry: item.entry,
            team_name: item.entry_name,
            manager_name: item.player_name,
            event_total: item.event_total,
            total_points: item.total,
            overall_rank: item.rank,
            last_rank: item.last_rank,
            rank_change: (item.last_rank || item.rank) - item.rank,
          })),
        };

        return jsonResponse(structuredLiveResponse);
      }

      // 2. KV READ: Metadata
      if (path[0] === "api" && path[1] === "kv" && path[2] === "metadata") {
        const leagueKey = url.searchParams.get("league_key");
        if (!leagueKey) return jsonResponse({ error: "Missing parameter: league_key" }, 400);

        const data = await env.FPL_HISTORICAL_DATA.get(`league:${leagueKey}:metadata`, "json");
        return data ? jsonResponse(data) : jsonResponse({ error: "Metadata not found in KV" }, 404);
      }

      // 3. KV READ: League Winners
      if (path[0] === "api" && path[1] === "kv" && path[2] === "winners") {
        const leagueKey = url.searchParams.get("league_key");
        if (!leagueKey) return jsonResponse({ error: "Missing parameter: league_key" }, 400);

        const data = await env.FPL_HISTORICAL_DATA.get(`league:${leagueKey}:winners`, "json");
        return data ? jsonResponse(data) : jsonResponse({ error: "Winners data not found in KV" }, 404);
      }

      // 4. KV READ: Historical Gameweek
      if (path[0] === "api" && path[1] === "kv" && path[2] === "gw") {
        const leagueKey = url.searchParams.get("league_key");
        const gw = url.searchParams.get("gw");

        if (!leagueKey || !gw) {
          return jsonResponse({ error: "Missing parameter: league_key or gw" }, 400);
        }

        const data = await env.FPL_HISTORICAL_DATA.get(`league:${leagueKey}:gw:${gw}`, "json");
        return data ? jsonResponse(data) : jsonResponse({ error: `Gameweek ${gw} history not found in KV` }, 404);
      }

      // 5. KV READ: Managers
      if (path[0] === "api" && path[1] === "kv" && path[2] === "managers") {
        const leagueKey = url.searchParams.get("league_key");
        if (!leagueKey) return jsonResponse({ error: "Missing parameter: league_key" }, 400);

        const data = await env.FPL_HISTORICAL_DATA.get(`league:${leagueKey}:managers`, "json");
        return data ? jsonResponse(data) : jsonResponse({ error: "Managers list not found in KV" }, 404);
      }

      return jsonResponse({ error: "Endpoint not found" }, 404);
    } catch (err: any) {
      return jsonResponse({ error: "Internal Server Error", message: err.message }, 500);
    }
  },
};
