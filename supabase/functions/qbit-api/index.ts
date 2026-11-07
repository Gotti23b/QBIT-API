import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Content-Type": "application/json",
};

const allowedCommands = new Set([
  "get_system_info", "get_battery_info", "get_network_info", "get_display_info",
  "set_volume", "media_control", "open_url", "open_settings",
  "create_folder", "create_file", "search_files", "lock_pc",\n  "android_open_accessibility_settings", "android_back", "android_home",\n  "android_notifications", "android_quick_settings", "android_lock_screen",\n  "android_volume_up", "android_volume_down", "android_volume_mute",\n  "android_brightness_up", "android_brightness_down",\n  "android_open_wifi_settings", "android_open_bluetooth_settings",\n  "android_open_display_settings", "android_open_sound_settings",\n  "android_open_battery_settings", "android_open_app_settings",
]);

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return response({ error: "Missing bearer token" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !publishableKey) return response({ error: "Supabase environment is not configured" }, 500);

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = authHeader.slice("Bearer ".length);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return response({ error: "Invalid or expired session" }, 401);
  const userId = authData.user.id;

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const baseIndex = parts.lastIndexOf("qbit-api");
  const route = parts.slice(baseIndex + 1);

  try {
    if (req.method === "GET" && route.length === 1 && route[0] === "devices") {
      const { data, error } = await supabase.from("qbit_devices")
        .select("id,name,platform,app_version,device_info,is_online,last_seen_at,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return response({ devices: data });
    }

    if (req.method === "POST" && route.length === 1 && route[0] === "devices") {
      const body = await req.json();
      if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 80) {
        return response({ error: "name must be 1-80 characters" }, 400);
      }
      if (!["windows", "android", "web"].includes(body.platform)) {
        return response({ error: "platform must be windows, android, or web" }, 400);
      }
      const { data, error } = await supabase.from("qbit_devices").insert({
        user_id: userId,
        name: body.name.trim(),
        platform: body.platform,
        app_version: typeof body.app_version === "string" ? body.app_version.slice(0, 40) : null,
        device_info: body.device_info && typeof body.device_info === "object" && !Array.isArray(body.device_info) ? body.device_info : {},
        is_online: true,
        last_seen_at: new Date().toISOString(),
      }).select("id,name,platform,app_version,is_online,last_seen_at,created_at").single();
      if (error) throw error;
      return response({ device: data }, 201);
    }

    if (route.length === 2 && route[0] === "devices" && route[1] && req.method === "PATCH") {
      const body = await req.json();
      const updates: Record<string, unknown> = {
        is_online: true,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (typeof body.app_version === "string") updates.app_version = body.app_version.slice(0, 40);
      if (body.device_info && typeof body.device_info === "object" && !Array.isArray(body.device_info)) updates.device_info = body.device_info;
      const { data, error } = await supabase.from("qbit_devices").update(updates)
        .eq("id", route[1]).select("id,name,platform,is_online,last_seen_at").maybeSingle();
      if (error) throw error;
      if (!data) return response({ error: "Device not found" }, 404);
      return response({ device: data });
    }

    if (route.length === 3 && route[0] === "devices" && route[2] === "commands" && route[1]) {
      const deviceId = route[1];

      if (req.method === "POST") {
        const body = await req.json();
        if (typeof body.command !== "string" || !allowedCommands.has(body.command)) {
          return response({ error: "Command is not allowed" }, 400);
        }
        const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
        if (JSON.stringify(payload).length > 8192) return response({ error: "Payload too large (8 KB max)" }, 413);

        const { data, error } = await supabase.from("qbit_device_commands").insert({
          user_id: userId, device_id: deviceId, command: body.command, payload,
        }).select("id,device_id,command,payload,status,created_at,expires_at").single();
        if (error) throw error;
        return response({ command: data }, 201);
      }

      if (req.method === "GET") {
        const { data, error } = await supabase.from("qbit_device_commands")
          .select("id,device_id,command,payload,status,created_at,expires_at")
          .eq("device_id", deviceId)
          .eq("status", "pending")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: true })
          .limit(50);
        if (error) throw error;
        return response({ commands: data });
      }
    }

    if (route.length === 3 && route[0] === "commands" && route[2] === "claim" && req.method === "POST") {
      const { data, error } = await supabase.from("qbit_device_commands")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", route[1]).eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .select("id,device_id,command,payload,status,expires_at").maybeSingle();
      if (error) throw error;
      if (!data) return response({ error: "Command unavailable or already claimed" }, 409);
      return response({ command: data });
    }

    if (route.length === 3 && route[0] === "commands" && route[2] === "result" && req.method === "PATCH") {
      const body = await req.json();
      if (!["completed", "failed"].includes(body.status)) return response({ error: "status must be completed or failed" }, 400);
      const resultValue = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : {};
      if (JSON.stringify(resultValue).length > 8192) return response({ error: "Result too large (8 KB max)" }, 413);
      const { data, error } = await supabase.from("qbit_device_commands").update({
        status: body.status,
        result: resultValue,
        error_message: typeof body.error_message === "string" ? body.error_message.slice(0, 500) : null,
        completed_at: new Date().toISOString(),
      }).eq("id", route[1]).eq("status", "running")
        .select("id,status,result,error_message,completed_at").maybeSingle();
      if (error) throw error;
      if (!data) return response({ error: "Command not found or not running" }, 404);
      return response({ command: data });
    }

    return response({ error: "Route not found" }, 404);
  } catch (error) {
    console.error("QBIT API error:", error);
    return response({ error: "Request failed", details: error instanceof Error ? error.message : "Unknown error" }, 400);
  }
});