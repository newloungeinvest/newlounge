// ============================================================
// NETLIFY FUNCTION — Webhook do Mercado Pago
// Caminho: /.netlify/functions/webhook-mp
// ============================================================
// O Mercado Pago chama esta função automaticamente quando
// o status de um pagamento muda. Aqui atualizamos o pedido
// no banco APENAS quando o MP confirma o pagamento.
// ============================================================

exports.handler = async (event) => {
  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  // O MP sempre espera resposta 200 rápido
  const ok = { statusCode: 200, body: 'OK' };

  if (event.httpMethod !== 'POST') return ok;
  if (!ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return ok;

  try {
    const body = JSON.parse(event.body || '{}');

    // O MP manda notificações de vários tipos; só nos importa "payment"
    const tipo = body.type || body.topic;
    if (tipo !== 'payment') return ok;

    const paymentId = body.data?.id || body.resource;
    if (!paymentId) return ok;

    // ===== BUSCAR DETALHES DO PAGAMENTO NO MP =====
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const pagamento = await mpResp.json();

    if (!mpResp.ok) return ok;

    const pedidoId = pagamento.external_reference;
    const statusMP = pagamento.status; // approved, pending, rejected, cancelled, refunded
    if (!pedidoId) return ok;

    // ===== MAPEAR STATUS DO MP PARA NOSSO SISTEMA =====
    const mapaStatus = {
      approved:    'pagamento_aprovado',
      pending:     'pagamento_pendente',
      in_process:  'pagamento_em_analise',
      rejected:    'pagamento_recusado',
      cancelled:   'cancelado',
      refunded:    'devolvido',
      charged_back:'devolvido',
    };
    const novoStatus = mapaStatus[statusMP] || 'pagamento_pendente';

    // ===== ATUALIZAR PEDIDO NO BANCO =====
    await fetch(`${SUPABASE_URL}/rest/v1/pedidos?id=eq.${pedidoId}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        status: novoStatus,
        metodo_pagamento: pagamento.payment_type_id || 'mercadopago',
        atualizado_em: new Date().toISOString(),
      }),
    });

    // ===== REGISTRAR EVENTO (auditoria de pagamento) =====
    // Grava o evento bruto para reconciliação futura
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/payment_events`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          pedido_id: pedidoId,
          payment_id: String(paymentId),
          status_mp: statusMP,
          valor: pagamento.transaction_amount || 0,
          metodo: pagamento.payment_type_id || '',
          raw: pagamento,
        }),
      });
    } catch (e) {
      // Se a tabela payment_events não existir, ignora (não bloqueia o webhook)
    }

    return ok;

  } catch (e) {
    // Mesmo em erro, responde 200 para o MP não ficar reenviando infinitamente
    return ok;
  }
};
