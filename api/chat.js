// pages/api/chat.js
// API para Vercel/Next.js (Pages Router)
// Flujo: intake (Facilitador) -> debate (Coach+agentes) -> fusión -> guard

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Falta GROQ_API_KEY en el entorno' });

    const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';

    // ===== Modelos =====
    const MODELS = {
      coach: 'groq/compound',
      tech: 'llama-3.1-8b-instant',
      biz: 'llama-3.3-70b-versatile',
      data: 'openai/gpt-oss-120b',
      data_fallback: 'openai/gpt-oss-20b',
      guard: 'meta-llama/llama-guard-4-12b',
      fac: 'llama-3.1-8b-instant' // Facilitador (antesala)
    };

    // ===== Prompts de sistema =====
    const SYS = {
      // Facilitador: propone Resumen en 1–2 turnos; no repite al usuario; reconduce objetivos incoherentes.
      fac: `Eres FACILITADOR amable y conciso.
Tareas:
1) Construye un RESUMEN con: objetivo (1 frase), restricciones (2–5), criterio_exito (1 frase), prioridad (una palabra), plazo (fecha o semanas), modo (lite|full).
2) Si detectas objetivo + plan/mode (free|lite|full), arma el RESUMEN de inmediato (no preguntes lo ya respondido).
3) Máximo 2 preguntas: si faltan datos tras 2 turnos, rellena con supuestos razonables y marca "supuestos".
4) Prohibido repetir literalmente las palabras del usuario como pregunta; parafrasea y propone.
5) Devuelve el JSON del RESUMEN entre <<<BRIEF>>> y <<<END>>> y luego SOLO: "¿Confirmas para iniciar debate o editar algo?"
Si el objetivo es incoherente (p.ej., “no obtener ganancias”), reconduce a opciones válidas (conservar capital / minimizar riesgo / maximizar ventas).`,

      coach: `Eres COACH-ORQUESTADOR. Sin saludos, sin definiciones.
Devuelve EXACTAMENTE:
- Decisión (1–2 frases)
- Plan 7 días (tabla)
- Riesgos + mitigación (tabla, 4 filas)
- Métricas/targets (5)
- Supuestos (≤5)
- Próximas decisiones (≤5)
Evalúa por {viabilidad, ROI, TTV, riesgo (bajo)}. Si falta contexto, infiérelo y decláralo en Supuestos.`,

      tech: `Eres ARQ-SW. Sin saludos/definiciones. Devuelve SOLO:
- Diagrama textual (componentes → flechas → datos)
- 3–5 endpoints (método, path, request/response)
- Snippet ≤60 líneas (pseudocódigo o TS)
- Riesgos (3) + coste mensual (bajo/medio/alto)
Sé específico y breve.`,

      biz: `Eres BIZ-VENTAS. Sin saludos/definiciones. Devuelve SOLO:
- ICP (5 bullets)
- Propuesta de valor (1 frase + 3 bullets)
- Canal #1 (playbook 4 semanas en tabla)
- Pricing inicial (3 tiers + justificación 1 línea)
- Objeciones (3) + respuestas
- Métricas de embudo (5)`,

      data: `Eres DATA-INNOV. Sin saludos/definiciones. Devuelve SOLO:
- 3 experimentos (hipótesis, métrica, criterio, n)
- Dashboard mínimo (North Star + 4)
- Plan de instrumentación (eventos clave + esquema)
- Notas: sesgos/atribución (≤3)`,

      guard: `Eres GUARD. Revisa seguridad/compliance/PII/claims.
Si todo bien, responde "OK-GUARD".
Si hay issues, devuelve SOLO una lista de correcciones puntuales; nada más.`
    };

    // ===== Utils =====
    async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
    function parseRetryAfterSeconds(txt){
      const m = /try again in ([0-9.]+)s/i.exec(txt||'');
      return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
    }
    function safeParseJSON(txt) { try { return JSON.parse(txt); } catch { return null; } }
    function cap(text, n = 2000) { return text && text.length > n ? text.slice(0, n) + '…' : (text || ''); }

    async function callGroqOnce(model, system, user, max_tokens = 800) {
      const r = await fetch(GROQ_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens,
          temperature: 0.3,
          top_p: 0.9,
          frequency_penalty: 0.2,
          presence_penalty: 0.0
        })
      });
      if (!r.ok) {
        const txt = await r.text();
        const err = new Error(`Groq ${model} ${r.status} ${r.statusText}: ${txt}`);
        err.status = r.status;
        err.raw = txt;
        throw err;
      }
      const j = await r.json();
      return j?.choices?.[0]?.message?.content || '';
    }

    // Retry + Backoff + Fallback (para 429 y estabilidad en plan free)
    async function callGroq(model, system, user, max_tokens = 800, {fallbackModel=null, retries=3} = {}) {
      let attempt = 0;
      let lastErr = null;
      const modelsToTry = [model, ...(fallbackModel ? [fallbackModel] : [])];

      while (attempt < retries * modelsToTry.length) {
        const currModel = modelsToTry[Math.min(Math.floor(attempt / retries), modelsToTry.length - 1)];
        try {
          return await callGroqOnce(currModel, system, user, max_tokens);
        } catch (e) {
          lastErr = e;
          if (e.status === 429) {
            const wait = parseRetryAfterSeconds(e.raw) ?? (400 * Math.pow(2, attempt) + Math.floor(Math.random()*200));
            await sleep(wait);
          } else {
            await sleep(250 * (attempt + 1));
          }
          attempt++;
        }
      }
      throw lastErr;
    }

    // Señales/normalización para validar el Resumen antes del debate
    function extractSignals(txt){
      const t = (txt||'').toLowerCase();
      return {
        wantsNoProfit: /\b(no (tener|obtener)\s+ganancias?|cero\s+ganancia|sin\s+ganancia)\b/.test(t),
        budget: (() => { const m = t.match(/\$?\s*(\d+)\s*(usd|dólares|dolares)?\b/); return m ? Number(m[1]) : null; })(),
        product: /\bgps\b/.test(t) ? 'GPS' : null,
        wantsSales: /\bventas?\b/.test(t) || /\bvender\b/.test(t),
        p2p: /\bp2p\b|transfer(encia|ir)|enviar dinero|wallet|billetera/.test(t),
        planLite: /free|gratis|lite/.test(t)
      };
    }

    function normalizeBusinessBrief(brief, signals, context){
      const out = { ...(brief || {}) };

      // Completar huecos con señales/por defecto
      if (!out.objetivo) {
        if (signals.product || signals.wantsSales) {
          out.objetivo = signals.product ? `Vender ${signals.product} online` : `Incrementar ventas online`;
        } else if (signals.p2p) {
          out.objetivo = 'Lanzar P2P para enviar dinero entre personas';
        }
      }
      if (!out.restricciones) out.restricciones = [];
      if (signals.budget && !out.restricciones.some(r=>/presupuesto/i.test(r))) {
        out.restricciones.push(`presupuesto $${signals.budget}`);
      }
      if (!out.modo) out.modo = (context?.lite || signals.planLite || context?.plan === 'free') ? 'lite' : 'full';
      if (!out.prioridad) out.prioridad = 'alta';
      if (!out.plazo) out.plazo = '4 semanas';
      if (!out.criterio_exito) {
        if (signals.wantsSales || /vender|venta/i.test(out.objetivo||'')) {
          out.criterio_exito = '≥ 50 pedidos con ROI positivo en 4 semanas';
        } else if (signals.p2p) {
          out.criterio_exito = '≥ 95% transferencias exitosas y ≥ 1k usuarios activos';
        } else {
          out.criterio_exito = 'Objetivo validado con métricas clave alcanzadas';
        }
      }

      // Reglas de sanidad: “no ganar” se reconduce
      let needsFix = false;
      let fixMsg = '';
      if (signals.wantsNoProfit) {
        needsFix = true;
        fixMsg = 'Detecté que mencionaste "no tener ganancias". ¿Prefieres **conservar capital** (ROI≈0) o **maximizar ventas** con tu presupuesto? Elige una opción para ajustar el Resumen.';
        if (!out.restricciones.includes('bajo riesgo')) out.restricciones.push('bajo riesgo');
        out.objetivo = out.objetivo || 'Conservar capital mientras se valida el negocio';
      }

      return { out, needsFix, fixMsg };
    }

    function scoreFromAgents(t, b, d) {
      const hasApi = /GET|POST|endpoint|schema|arquitectura|OpenAPI/i.test(t || '') ? 0.9 : 0.6;
      const hasGtm = /canal|pricing|ICP|propuesta|embudo|ventas/i.test(b || '') ? 0.9 : 0.6;
      const hasExp = /experimento|hipótesis|métrica|dashboard|instrumentación/i.test(d || '') ? 0.9 : 0.6;
      const viabilidad = hasApi, roi = hasGtm, ttv = (hasApi + hasGtm) / 2, riesgo = 1 - Math.min(hasApi, hasGtm, hasExp);
      const total = (viabilidad + roi + ttv + (1 - riesgo)) / 4;
      return { viabilidad, roi, ttv, riesgo, total, rationale: 'Señales: API+GTM+experimentos presentes' };
    }

    // ===== Entrada =====
    const { message, context, phase = 'intake', brief } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message requerido (string)' });
    }

    // ===== Fase 1: INTAKE (Facilitador) =====
    if (phase === 'intake') {
      const turns = Number((context?.__intake_turns ?? 0)) + 1;

      const signalsMsg = extractSignals(message);
      const facPrompt = `Contexto: ${JSON.stringify({ ...context, __intake_turns: turns })}
Usuario: ${message}
Si es posible, devuelve el JSON entre <<<BRIEF>>> y <<<END>>>.
Recuerda: máximo 2 preguntas; si faltan datos, completa con supuestos.`;

      const facOut = await callGroq(MODELS.fac, SYS.fac, facPrompt, 450);

      const m = facOut.match(/<<<BRIEF>>>([\s\S]*?)<<<END>>>/);
      const briefJson = m ? safeParseJSON(m[1]) : null;

      let reply = facOut.replace(/<<<BRIEF>>>([\s\S]*?)<<<END>>>/g, '').trim();

      // Si tras 2 turnos no hay resumen, proponemos uno base con supuestos
      let briefOut = briefJson;
      if (!briefOut && turns >= 2) {
        briefOut = {
          objetivo: 'Validar ventas online con presupuesto acotado',
          restricciones: ['plan free', 'bajo riesgo', 'bajas comisiones'],
          criterio_exito: 'primeras 20 ventas con ROI ≥ 0',
          prioridad: 'alta',
          plazo: '4 semanas',
          modo: (context?.lite || context?.plan === 'free') ? 'lite' : 'full',
          supuestos: ['KYC básico si aplica', 'cumplimiento mínimo requerido']
        };
        reply = (reply ? reply + '\n\n' : '') + 'Propongo este Resumen inicial. ¿Confirmas para iniciar debate o editamos algo?';
      }

      // Normaliza/valida
      const { out: normalized, needsFix, fixMsg } = normalizeBusinessBrief(briefOut, signalsMsg, context || {});
      const nextHint = needsFix ? 'needs_fix' : (normalized ? 'ready' : 'intake');

      return res.status(200).json({
        reply: needsFix ? (reply ? reply + '\n\n' + fixMsg : fixMsg) : reply,
        brief: normalized || null,
        next_phase_hint: nextHint,
        context_echo: { ...(context||{}), __intake_turns: turns }
      });
    }

    // ===== Fase 2: DEBATE (Coach + agentes + guardia) =====
    const transcript = [];

    const effectiveBrief = brief || {
      objetivo: message,
      restricciones: [],
      criterio_exito: 'Éxito = utilidad y claridad.',
      prioridad: 'media',
      plazo: '4 semanas',
      modo: context?.lite ? 'lite' : 'full'
    };

    // Prompt para Coach
    const coachUser = `RESUMEN
OBJETIVO: ${effectiveBrief.objetivo}
RESTRICCIONES: ${effectiveBrief.restricciones?.join('; ') || 'ninguna'}
CRITERIO_EXITO: ${effectiveBrief.criterio_exito}
PRIORIDAD: ${effectiveBrief.prioridad}  PLAZO: ${effectiveBrief.plazo}
MODO: ${effectiveBrief.modo}
Criterios: viabilidad, ROI, TTV, riesgo (bajo).

Formato EXACTO (sin saludos):
- Decisión (1–2 frases)
- Plan 7 días (tabla)
- Riesgos + mitigación (tabla)
- Métricas/targets (5)
- Supuestos (≤5)
- Próximas decisiones (≤5)
`;

    // 1) Coach contextualiza (R1)
    const coachPlan = await callGroq(MODELS.coach, SYS.coach, coachUser, 650);
    transcript.push({ agent: 'coach', round: 1, content: cap(coachPlan) });

    // Selección dinámica: lite = Coach+Tech; full = Coach+Tech+Biz+Data
    const lite = effectiveBrief.modo === 'lite' || !!context?.lite;
    const agentsToCall = lite ? ['tech'] : ['tech', 'biz', 'data'];

    // Helper: ejecutar en secuencia para suavizar TPM
    async function seq(tasks){
      const out = [];
      for (const t of tasks) out.push(await t());
      return out;
    }

    // 2) Ronda 1 (agentes) — secuencial
    const r1 = await seq([
      () => agentsToCall.includes('tech') ? callGroq(MODELS.tech, SYS.tech, coachPlan, 550) : Promise.resolve(''),
      () => agentsToCall.includes('biz')  ? callGroq(MODELS.biz,  SYS.biz,  coachPlan, 550) : Promise.resolve(''),
      () => agentsToCall.includes('data') ? callGroq(MODELS.data, SYS.data, coachPlan, 550, { fallbackModel: MODELS.data_fallback }) : Promise.resolve(''),
    ]);
    let [techR1, bizR1, dataR1] = r1;

    if (agentsToCall.includes('tech')) transcript.push({ agent: 'tech', round: 1, content: cap(techR1) });
    if (agentsToCall.includes('biz'))  transcript.push({ agent: 'biz',  round: 1, content: cap(bizR1) });
    if (agentsToCall.includes('data')) transcript.push({ agent: 'data', round: 1, content: cap(dataR1) });

    // 3) Ronda 2 (réplica breve) SOLO si hay conflicto claro
    let techR2 = '', bizR2 = '', dataR2 = '';
    const conflict =
      (/CQRS|Event\s*Sourcing|DDD/i.test(techR1||'')) && (/lanzar rápido|sin DDD|go-to-market/i.test(bizR1||'')) ||
      (/pricing|freemium|CAC|ROI/i.test(bizR1||'')) && (/coste|latencia|SLA/i.test(techR1||''));

    if (!lite && conflict) {
      const summaryForRound2 =
`RESUMEN R1 (máx 100 palabras por agente)
- ARQ:\n${cap(techR1, 500)}
- BIZ:\n${cap(bizR1, 500)}
- DATA:\n${cap(dataR1, 500)}
Indica SOLO ajustes críticos y trade-offs en 4 bullets.`;
      const r2 = await seq([
        () => agentsToCall.includes('tech') ? callGroq(MODELS.tech, SYS.tech, summaryForRound2, 420) : Promise.resolve(''),
        () => agentsToCall.includes('biz')  ? callGroq(MODELS.biz,  SYS.biz,  summaryForRound2, 420) : Promise.resolve(''),
        () => agentsToCall.includes('data') ? callGroq(MODELS.data, SYS.data, summaryForRound2, 420, { fallbackModel: MODELS.data_fallback }) : Promise.resolve(''),
      ]);
      [techR2, bizR2, dataR2] = r2;
      if (techR2) transcript.push({ agent: 'tech', round: 2, content: cap(techR2) });
      if (bizR2)  transcript.push({ agent: 'biz',  round: 2, content: cap(bizR2) });
      if (dataR2) transcript.push({ agent: 'data', round: 2, content: cap(dataR2) });
    }

    // 4) Fusión + score (Coach)
    const scores = scoreFromAgents(techR2 || techR1, bizR2 || bizR1, dataR2 || dataR1);
    const fusedPrompt =
`FUSIÓN
Puntajes: ${JSON.stringify(scores)}
Devuelve EXACTAMENTE:
- Decisión (1–2 frases)
- Plan 7 días (tabla)
- Riesgos + mitigación (tabla)
- Métricas/targets (5)
- Supuestos (≤5)
- Próximas decisiones (≤5)

ARQ-DEF:
${cap(techR2 || techR1, 1100)}

BIZ-DEF:
${cap(bizR2 || bizR1, 1100)}

DATA-DEF:
${cap(dataR2 || dataR1, 1100)}
`;
    const fused = await callGroq(MODELS.coach, SYS.coach, fusedPrompt, 650);
    transcript.push({ agent: 'coach', round: 3, content: cap(fused) });

    // 5) Guardia — revisar en silencio
    const guard1 = await callGroq(MODELS.guard, SYS.guard, fused, 200);
    let reply = fused;
    if (!/OK-GUARD/i.test(guard1)) {
      const patched = await callGroq(
        MODELS.coach,
        SYS.coach,
        `Aplica estas correcciones sin cambiar el contenido esencial:\n${guard1}\n\nTexto:\n${fused}`,
        480
      );
      const guard2 = await callGroq(MODELS.guard, SYS.guard, patched, 180);
      reply = /OK-GUARD/i.test(guard2) ? patched : fused;
    }

    return res.status(200).json({
      reply,
      transcript,
      scores,
      agents_called: Object.values(MODELS),
    });

  } catch (error) {
    console.error('Error en /api/chat:', error);
    return res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
}
