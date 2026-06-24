// ============================================================
// NETLIFY FUNCTION — Criar pagamento no Mercado Pago
// Caminho: /.netlify/functions/criar-pagamento
// ============================================================
// Esta função roda no SERVIDOR. O Access Token fica seguro
// nas variáveis de ambiente do Netlify, nunca no frontend.
// ============================================================

exports.handler = async (event) => {
  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SITE_URL = process.env.SITE_URL || 'https://newloungeinvest.com.br';

  if (!ACCESS_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'MP_ACCESS_TOKEN não configurado no Netlify' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { itens, cliente, endereco, pedidoId, frete = 0, desconto = 0, cupom = '' } = body;

    if (!itens || !itens.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Carrinho vazio' }) };
    }
    if (!cliente || !cliente.email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dados do cliente ausentes' }) };
    }

    // ===== VALIDAÇÃO DE PREÇO NO SERVIDOR =====
    // Busca os preços reais no banco para impedir manipulação pelo cliente
    let itensValidados = itens;
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const ids = itens.map(i => i.id).filter(Boolean);
      if (ids.length) {
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/produtos?id=in.(${ids.join(',')})&select=id,nome,preco,preco_promo`,
          { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
        );
        const produtosReais = await resp.json();
        // Substitui o preço do cliente pelo preço real do banco
        itensValidados = itens.map(item => {
          const real = produtosReais.find(p => p.id === item.id);
          if (real) {
            const precoReal = real.preco_promo || real.preco;
            return { ...item, preco: precoReal, nome: real.nome };
          }
          return item;
        });
      }
    }

    // ===== MONTAR ITENS PARA O MP =====
    const items = itensValidados.map(i => ({
      title: String(i.nome || 'Produto').substring(0, 250),
      quantity: parseInt(i.qty) || 1,
      unit_price: Number(i.preco),
      currency_id: 'BRL',
      picture_url: i.foto || undefined,
    }));

    // Frete como item
    if (frete > 0) {
      items.push({
        title: 'Frete',
        quantity: 1,
        unit_price: Number(frete),
        currency_id: 'BRL',
      });
    }

    // ===== PREFERÊNCIA DE PAGAMENTO =====
    const preference = {
      items,
      payer: {
        name: cliente.nome || '',
        email: cliente.email,
        phone: cliente.fone ? { number: cliente.fone.replace(/\D/g, '') } : undefined,
        identification: cliente.cpf ? { type: 'CPF', number: cliente.cpf.replace(/\D/g, '') } : undefined,
        address: endereco ? {
          zip_code: (endereco.cep || '').replace(/\D/g, ''),
          street_name: endereco.logradouro || '',
          street_number: endereco.numero || '',
        } : undefined,
      },
      back_urls: {
        success: `${SITE_URL}/checkout-sucesso.html?pedido=${pedidoId || ''}`,
        pending: `${SITE_URL}/checkout-sucesso.html?pedido=${pedidoId || ''}&status=pendente`,
        failure: `${SITE_URL}/checkout-sucesso.html?pedido=${pedidoId || ''}&status=recusado`,
      },
      auto_return: 'approved',
      external_reference: pedidoId || '',
      statement_descriptor: 'NEWLOUNGE SPORT',
      // Desconto via cupom (se houver) — aplicado como redução geral
      ...(desconto > 0 ? {
        items: [...items, { title: `Desconto ${cupom}`, quantity: 1, unit_price: -Number(desconto), currency_id: 'BRL' }]
      } : {}),
      payment_methods: {
        excluded_payment_types: [],   // aceita todos (Pix, cartão, boleto)
        installments: 12,             // até 12x
      },
      notification_url: `${SITE_URL}/.netlify/functions/webhook-mp`,
    };

    // ===== CHAMAR API DO MERCADO PAGO =====
    const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'X-Idempotency-Key': `${pedidoId || Date.now()}`,
      },
      body: JSON.stringify(preference),
    });

    const mpData = await mpResp.json();

    if (!mpResp.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Erro ao criar pagamento no Mercado Pago', detalhe: mpData }),
      };
    }

    // Retorna o link de checkout do MP
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        init_point: mpData.init_point,           // URL de produção
        sandbox_init_point: mpData.sandbox_init_point,
        preference_id: mpData.id,
      }),
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erro interno', message: e.message }),
    };
  }
};
