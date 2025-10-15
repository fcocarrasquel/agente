// pages/api/chat.js
// API para Vercel/Next.js (Pages Router): intake (Facilitador) -> debate (Coach + agentes) -> guardia
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
      guard: 'meta-llama/llama-guard-4-12b',
      fac: 'llama-3.1-8b-instant' // Facilitador (antesala)
    };

    // ===== Prompts de sistema =====
    const SYS = {
      fac: `Eres FACILITADOR. Habla amable y breve.
Objetivo: construir un BRIEF en 1–3 turnos.
Obtén:
- objetivo (1 frase)
- 2–5 restricciones
- criterio_exito (1 frase)
- prioridad (una palabra)
- plazo (fecha o semanas)
- modo (lite|full)
Si falta info, pregunta UNA cosa por turno.
Cuando lo tengas, muestra el JSON SOLO entre <<<BRIEF>>> y <<<END>>> y pregunta: "¿Confirmas para iniciar debate?". Prohibido saludar largo o definir conceptos.`,

      coach: `Eres COACH-ORQUESTADOR. Prohibido saludar, definir conceptos o pedir al usuario "¿en qué ayudo?".
Responde solo con:
- Decisión (1–2 frases)
- Plan 7 días (tabla)
- Riesgos + mitigación (tabla, 4 filas)
- Métricas/targets (5)
- Supuestos (≤5)
- Próximas decisiones (≤5)
Evalúa por {viabilidad, ROI, TTV, riesgo (bajo)}. Si falta contexto crítico, infiérelo y decláralo en Supuestos.`,

      tech: `Eres ARQ-SW. Prohibido saludar/definir. Entrega solo:
- Diagrama textual (componentes → flechas → datos)
- 3–5 endpoints (método, path, request/response)
- Snippet ≤60 líneas (pseudocódigo o TS)
- Riesgos (3) + coste mensual estimado (bajo/medio/alto)
Sé conciso y específico.`,

      biz: `Eres BIZ-VENTAS. Prohibido saludar/definir. Entrega solo:
- ICP (5 bullets)
- Propuesta de valor (1 frase + 3 bullets)
- Canal #1 (playbook 4 semanas en tabla)
- Pricing inicial (3 tiers + justif. 1 línea)
- Objeciones (3) + respuestas
- Métricas de embudo (5)
Sé pragmático.`,

      data: `Eres DATA-INNOV. Prohibido saludar/definir. Entrega solo:
- 3 experimentos (hipótesis, métrica, criterio, n)
- Dashboard mínimo (North Star + 4)
- Plan de instrumentación (eventos clave + esquema)
- Notas: sesgos/atribución (≤3)`,

      guard: `Eres GUARD. Revisa seguridad/compliance, PII y claims. Si todo está bien, devuelve "OK-GUARD".
Si no, devuelve solo una lista de correcciones puntuales; nunca reescribas toda la respuesta.`
    };

    // ===== Utilidades =====
    async function callGroq(model, system, user, max_tokens = 800) {
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
      if (!r.ok) throw new Error(`Groq ${model} ${r.status} ${r.statusText}: ${await r.text()}`);
      const j = await r.json();
      return j?.choices?.[0]?.message?.content || '';
    }

    function safeParseJSON(txt) { try { return JSON.parse(txt); } catch { return null; } }
    function cap(text, n = 2000) { return text && text.length > n ? text.slice(0, n) + '…' : (text || ''); }

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
      const facPrompt = `Contexto: ${JSON.stringify(context || {})}
Usuario: ${message}
Si es posible, devuelve el JSON entre <<<BRIEF>>> y <<<END>>>.`;
      const facOut = await callGroq(MODELS.fac, SYS.fac, facPrompt, 500);

      const m = facOut.match(/<<<BRIEF>>>([\s\S]*?)<<<END>>>/);
      const briefJson = m ? safeParseJSON(m[1]) : null;
      const reply = facOut.replace(/<<<BRIEF>>>([\s\S]*?)<<<END>>>/g, '').trim();

      return res.status(200).json({
        reply,
        brief: briefJson,
        next_phase_hint: briefJson ? 'ready' : 'intake'
      });
    }

    // ===== Fase 2: DEBATE (Coach + agentes + guardia) =====
    const transcript = [];

    const effectiveBrief = brief || {
      objetivo: message,
      restricciones: [],
      criterio_exito: 'Éxito = utilidad y claridad para el usuario.',
      prioridad: 'media',
      plazo: '4 semanas',
      modo: context?.lite ? 'lite' : 'full'
    };

    const coachUser = `BRIEF
OBJETIVO: ${effectiveBrief.objetivo}
RESTRICCIONES: ${effectiveBrief.restricciones?.join('; ') || 'ninguna'}
CRITERIO_EXITO: ${effectiveBrief.criterio_exito}
PRIORIDAD: ${effectiveBrief.prioridad}  PLAZO: ${effectiveBrief.plazo}
MODO: ${effectiveBrief.modo}
Criterios: viabilidad, ROI, TTV, riesgo (bajo).

Formato obligatorio sin saludos:
- Decisión (1–2 frases)
- Plan 7 días (tabla)
- Riesgos + mitigación (tabla)
- Métricas/targets (5)
- Supuestos (≤5)
- Próximas decisiones (≤5)
`;

    // 1) Coach contextualiza
    const coachPlan = await callGroq(MODELS.coach, SYS.coach, coachUser, 700);
    transcript.push({ agent: 'coach', round: 1, content: cap(coachPlan) });

    // Selección dinámica (modo lite = menos agentes)
    const lite = effectiveBrief.modo === 'lite' || !!context?.lite;
    const agentsToCall = lite ? ['tech'] : ['tech', 'biz', 'data'];

    // 2) Ronda 1 en paralelo
    const callsR1 = [];
    if (agentsToCall.includes('tech')) callsR1.push(callGroq(MODELS.tech, SYS.tech, coachPlan, 800));
    if (agentsToCall.includes('biz'))  callsR1.push(callGroq(MODELS.biz,  SYS.biz,  coachPlan, 800));
    if (agentsToCall.includes('data')) callsR1.push(callGroq(MODELS.data, SYS.data, coachPlan, 800));
    const r1 = await Promise.all(callsR1);

    let idx = 0, techR1 = '', bizR1 = '', dataR1 = '';
    if (agentsToCall.includes('tech')) techR1 = r1[idx++] || '';
    if (agentsToCall.includes('biz'))  bizR1  = r1[idx++] || '';
    if (agentsToCall.includes('data')) dataR1 = r1[idx++] || '';

    if (techR1) transcript.push({ agent: 'tech', round: 1, content: cap(techR1) });
    if (bizR1)  transcript.push({ agent: 'biz',  round: 1, content: cap(bizR1) });
    if (dataR1) transcript.push({ agent: 'data', round: 1, content: cap(dataR1) });

    // 3) Ronda 2 (réplica breve) si no es lite
    let techR2 = '', bizR2 = '', dataR2 = '';
    if (!lite) {
      const summaryForRound2 =
        `RESUMEN R1 (máx 120 palabras por ajuste)
- ARQ:\n${cap(techR1, 600)}
- BIZ:\n${cap(bizR1, 600)}
- DATA:\n${cap(dataR1, 600)}
Indica SOLO ajustes críticos y trade-offs.`;

      const r2 = await Promise.all([
        agentsToCall.includes('tech') ? callGroq(MODELS.tech, SYS.tech, summaryForRound2, 450) : Promise.resolve(''),
        agentsToCall.includes('biz')  ? callGroq(MODELS.biz,  SYS.biz,  summaryForRound2, 450) : Promise.resolve(''),
        agentsToCall.includes('data') ? callGroq(MODELS.data, SYS.data, summaryForRound2, 450) : Promise.resolve(''),
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
Genera:
- Decisión (1–2 frases)
- Plan 7 días (tabla)
- Riesgos + mitigación (tabla)
- Métricas/targets (5)
- Supuestos (≤5)
- Próximas decisiones (≤5)

ARQ-DEF:
${cap(techR2 || techR1, 1500)}

BIZ-DEF:
${cap(bizR2 || bizR1, 1500)}

DATA-DEF:
${cap(dataR2 || dataR1, 1500)}
`;

    const fused = await callGroq(MODELS.coach, SYS.coach, fusedPrompt, 900);
    transcript.push({ agent: 'coach', round: 3, content: cap(fused) });

    // 5) Guardia — intentamos limpiar sin mostrar “Ajustado por GUARD”
    const guard1 = await callGroq(MODELS.guard, SYS.guard, fused, 400);
    let reply = fused;
    if (!/OK-GUARD/i.test(guard1)) {
      const patched = await callGroq(
        MODELS.coach,
        SYS.coach,
        `Aplica estas correcciones sin cambiar el contenido esencial:\n${guard1}\n\nTexto:\n${fused}`,
        600
      );
      const guard2 = await callGroq(MODELS.guard, SYS.guard, patched, 300);
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

