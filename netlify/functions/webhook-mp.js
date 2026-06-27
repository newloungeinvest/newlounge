// ============================================================
// NETLIFY FUNCTION — Webhook do Mercado Pago
// VERSÃO 2 — com validação de assinatura
// ============================================================
exports.handler = async (event) => {
  const ACCESS_TOKEN      = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL      = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const WEBHOOK_SECRET    = process.env.MP_WEBHOOK_SECRET;

  const ok  = { statusCode: 200, body: 'OK' };
  const err = { statusCode: 200, body: 'IGNORED' }; // sempre 200 pro MP não reenviar em loop

  if (event.httpMethod !== 'POST') return ok;
  if (!ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return err;

  // ===== VALIDAÇÃO DE ASSINATURA DO MERCADO PAGO =====
  // O MP envia x-signature e x-request-id em todo webhook de produção
  if (WEBHOOK_SECRET) {
    const signature = event.headers['x-signature'];
    const requestId = event.headers['x-request-id'];

    if (!signature) {
      console.error('Webhook sem x-signature — rejeitado');
      return err;
    }

    // Extrai ts e v1 do header x-signature
    const parts = {};
    signature.split(',').forEach(part => {
      const [k, v] = part.trim().split('=');
      parts[k] = v;
    });

    const ts = parts['ts'];
    const v1 = parts['v1'];

    if (!ts || !v1) {
      console.error('x-signature malformado — rejeitado');
      return err;
    }

    // Monta o manifest para validação
    const body   = event.body || '';
    const dataId = (() => {
      try { return JSON.parse(body)?.data?.id || ''; } catch { return ''; }
    })();

    const manifest = `id:${dataId};request-id:${requestId || ''};ts:${ts};`;

    // Calcula HMAC-SHA256
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(manifest)
      .digest('hex');

    if (expected !== v1) {
      console.error('Assinatura inválida — possível webhook falso rejeitado');
      return err;
    }
  }

  // ===== PROCESSAR WEBHOOK =====
  try {
    const body = JSON.parse(event.body || '{}');
    const tipo = body.type || body.topic;
    if (tipo !== 'payment') return ok;

    const paymentId = body.data?.id || body.resource;
    if (!paymentId) return ok;

    // Busca detalhes reais do pagamento direto no MP
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const pagamento = await mpResp.json();
    if (!mpResp.ok) return err;

    const pedidoId = pagamento.external_reference;
    const statusMP = pagamento.status;
    if (!pedidoId) return ok;

    // ===== VALIDAÇÃO DE VALOR =====
    // Busca o total esperado no banco antes de aprovar
    const pedidoResp = await fetch(
      `${SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}&select=total,status`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const pedidos = await pedidoResp.json();
    const pedido  = pedidos?.[0];

    if (!pedido) {
      console.error(`Pedido ${pedidoId} não encontrado no banco`);
      return err;
    }

    // Se pagamento aprovado, valida se o valor bate (tolerância de R$ 0,10)
    if (statusMP === 'approved') {
      const valorPago    = Number(pagamento.transaction_amount || 0);
      const valorEsperado = Number(pedido.total || 0);
      const diferenca    = Math.abs(valorPago - valorEsperado);

      if (diferenca > 0.10) {
        console.error(`Valor divergente — esperado: ${valorEsperado}, pago: ${valorPago}`);
        // Marca pedido como suspeito em vez de aprovar
        await atualizarPedido(SUPABASE_URL, SUPABASE_SERVICE_KEY, pedidoId, {
          status: 'pagamento_suspeito',
          atualizado_em: new
