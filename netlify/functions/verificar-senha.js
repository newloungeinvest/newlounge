// ============================================================
// NETLIFY FUNCTION — Verificação de senha do Simulador
// Caminho: /.netlify/functions/verificar-senha
// A senha fica na variável de ambiente SIMULADOR_SENHA
// nunca exposta no frontend.
// ============================================================

exports.handler = async (event) => {
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
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false }) };
  }

  const SENHA_CORRETA = process.env.SIMULADOR_SENHA;

  if (!SENHA_CORRETA) {
    // Variável não configurada — bloqueia acesso por segurança
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, erro: 'Configuração ausente no servidor.' }),
    };
  }

  try {
    const { senha } = JSON.parse(event.body || '{}');

    if (!senha || typeof senha !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false }) };
    }

    // Comparação simples — sem timing attack relevante para este caso de uso
    if (senha.trim() === SENHA_CORRETA.trim()) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } else {
      // Pequeno delay para dificultar brute-force
      await new Promise(r => setTimeout(r, 800));
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, erro: 'Senha incorreta.' }) };
    }
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, erro: 'Erro interno.' }),
    };
  }
};
