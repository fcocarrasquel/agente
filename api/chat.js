// pages/api/chat.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const { message, context } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message requerido (string)' });
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Falta GROQ_API_KEY en el entorno' });

    const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
    const MODELS = {
      coach: 'groq/compound',
      tech: 'llama-3.1-8b-instant',
      biz: 'llama-3.3-70b-versatile',
      data: 'openai/gpt-oss-120b',
      guard: 'meta-llama/llama-guard-4-12b',
    };

    const SYS = {
      coach: 'Eres COACH-ORQUESTADOR. Resume el problema, define objetivos y criterios {viabilidad, ROI, TTV, riesgo}. Convoca solo a los expertos necesarios. Exige respuestas accionables, puntúa opciones y entrega una propuesta ganadora con plan 7 días, métricas y riesgos.',
      tech: 'Eres ARQ-SW. Diseña arquitectura robusta, contratos de API, riesgos y costos. Responde en bullets con snippet/pseudocódigo breve.',
      biz: 'Eres BIZ-VENTAS. Define ICP, propuesta de valor, canal #1 (playbook 4 semanas), pricing inicial, objeciones y métricas de embudo.',
      data: 'Eres DATA-INNOV. Propón 3 experimentos (hipótesis, métrica, criterio de éxito, n), dashboard mínimo (North Star + 4 líderes) e instrumentación de datos.',
      guard: 'Eres GUARD. Revisa seguridad/compliance, PII y claims. Si ok, devuelve "OK-GUARD"; si no, sugiere correcciones claras.',
    };

    async function callGroq(model, system, user, max_tokens = 800) {
      const r = await fetch(GROQ_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens })
      });
      if (!r.ok) throw new Error(`Groq ${model} ${r.status} ${r.statusText}: ${await r.text()}`);
      const j = await r.json();
      return j?.choices?.[0]?.message?.content || '';
    }

    const transcript = [];

    // 1) Coach: contextualiza
    const coachUser = `USER: ${message}\nCTX: ${JSON.stringify(context || {})}\nCriterios: viabilidad, ROI, TTV, riesgo.`;
    const coachPlan = await callGroq(MODELS.coach, SYS.coach, coachUser, 800);
    transcript.push({ agent: 'coach', round: 1, content: coachPlan.slice(0, 2000) });

    // 2) Ronda 1 en paralelo
    const [techR1, bizR1, dataR1] = await Promise.all([
      callGroq(MODELS.tech, SYS.tech, coachPlan, 900),
      callGroq(MODELS.biz, SYS.biz, coachPlan, 900),
      callGroq(MODELS.data, SYS.data, coachPlan, 900),
    ]);
    transcript.push({ agent: 'tech', round: 1, content: techR1.slice(0, 2000) });
    transcript.push({ agent: 'biz', round: 1, content: bizR1.slice(0, 2000) });
    transcript.push({ agent: 'data', round: 1, content: dataR1.slice(0, 2000) });

    // 3) Resumen para réplica (opcional, breve)
    const summaryForRound2 =
      `RESUMEN R1\n- ARQ:\n${techR1.slice(0, 800)}\n- BIZ:\n${bizR1.slice(0, 800)}\n- DATA:\n${dataR1.slice(0, 800)}\nIndica SOLO ajustes críticos y trade-offs.`;

    const [techR2, bizR2, dataR2] = await Promise.all([
      callGroq(MODELS.tech, SYS.tech, summaryForRound2, 600),
      callGroq(MODELS.biz, SYS.biz, summaryForRound2, 600),
      callGroq(MODELS.data, SYS.data, summaryForRound2, 600),
    ]);
    transcript.push({ agent: 'tech', round: 2, content: techR2.slice(0, 2000) });
    transcript.push({ agent: 'biz', round: 2, content: bizR2.slice(0, 2000) });
    transcript.push({ agent: 'data', round: 2, content: dataR2.slice(0, 2000) });

    // 4) Fusión + scoring (heurística simple)
    function scoreFromAgents(t, b, d) {
      const hasApi = /GET|POST|endpoint|schema|arquitectura/i.test(t) ? 0.9 : 0.6;
      const hasGtm = /canal|pricing|ICP|propuesta|embudo|ventas/i.test(b) ? 0.9 : 0.6;
      const hasExp = /experimento|hipótesis|métrica|dashboard|instrumentación/i.test(d) ? 0.9 : 0.6;
      const viabilidad = hasApi, roi = hasGtm, ttv = (hasApi + hasGtm) / 2, riesgo = 1 - Math.min(hasApi, hasGtm, hasExp);
      const total = (viabilidad + roi + ttv + (1 - riesgo)) / 4;
      return { viabilidad, roi, ttv, riesgo, total, rationale: 'Heurística: API+GTM+experimentos presentes' };
    }
    const scores = scoreFromAgents(techR2 || techR1, bizR2 || bizR1, dataR2 || dataR1);

    const fusedPrompt =
      `FUSIÓN\nPuntajes: ${JSON.stringify(scores)}\nGenera: (1) decisión única, (2) plan 7 días, (3) riesgos/mitigación, (4) métricas/targets, (5) supuestos, (6) siguientes decisiones.\n\n` +
      `ARQ-DEF:\n${(techR2 || techR1).slice(0, 1500)}\n\nBIZ-DEF:\n${(bizR2 || bizR1).slice(0, 1500)}\n\nDATA-DEF:\n${(dataR2 || dataR1).slice(0, 1500)}`;

    const fused = await callGroq(MODELS.coach, SYS.coach, fusedPrompt, 900);
    transcript.push({ agent: 'coach', round: 3, content: fused.slice(0, 2000) });

    // 5) Guardia de contenido
    const guard = await callGroq(MODELS.guard, SYS.guard, fused, 400);
    const reply = /OK-GUARD|\\bOK\\b/i.test(guard) ? fused : `【Ajustado por GUARD】\n${fused}\n\nNotas de guardia: ${guard}`;

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
