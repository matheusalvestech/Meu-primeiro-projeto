require('dns').setDefaultResultOrder('ipv4first'); 
require('dotenv').config();
console.log("DEBUG - O e-mail carregado foi:", process.env.EMAIL_REMETENTE);
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
let db;

function inicializarBanco() {
    const path = require('path');
    const dbPath = process.env.RENDER ? '/tmp/historico_leis.db' : './historico_leis.db';
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) console.error("ERRO AO ABRIR BANCO:", err);
        else console.log("✅ Banco de dados conectado com sucesso!");
    });
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const CHAVE_SECRETA = process.env.CHAVE_SECRETA;
let estaSincronizando = false;

const carteiro = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        // Agora o servidor puxa os dados do arquivo .env!
        user: process.env.EMAIL_REMETENTE, 
        pass: process.env.SENHA_EMAIL
    },
    tls: { rejectUnauthorized: false }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS leis_analisadas (id INTEGER PRIMARY KEY AUTOINCREMENT, id_lei TEXT, ementa TEXT, impacto TEXT, resumo_ia TEXT, usuario_id INTEGER, data_analise DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
    // MUDANÇA 1: Tabela de usuários agora tem "status" e "codigo_verificacao"
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT UNIQUE, senha TEXT, segmento TEXT, status TEXT DEFAULT 'pendente', codigo_verificacao TEXT)`);
});

function verificarCracha(req, res, next) {
    const cabecalho = req.headers['authorization'];
    if (!cabecalho) return res.status(403).json({ erro: "Acesso negado." });
    const token = cabecalho.split(' ')[1];
    jwt.verify(token, CHAVE_SECRETA, (err, usuario) => {
        if (err) return res.status(403).json({ erro: "Login inválido." });
        req.usuario = usuario; 
        next(); 
    });
}

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// MUDANÇA 2: O Cadastro agora gera o código e envia por e-mail
app.post('/api/cadastrar', async (req, res) => {
    const { nome, email, senha, segmento } = req.body;
    
    // Gera um código aleatório de 6 números (ex: 482910)
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        const senhaCriptografada = await bcrypt.hash(senha, 10);
        db.run(`INSERT INTO usuarios (nome, email, senha, segmento, codigo_verificacao) VALUES (?, ?, ?, ?, ?)`, 
        [nome, email, senhaCriptografada, segmento, codigo], function(err) {
            if (err) return res.status(400).json({ erro: "E-mail já em uso." });
            
            // Envia o código por e-mail com Raio-X de erros
            console.log(`📧 Tentando enviar código de ativação para ${email}...`);
            
            carteiro.sendMail({
                from: process.env.EMAIL_REMETENTE,
                to: email,
                subject: '🔐 Código de Verificação do seu Cadastro',
                html: `<h2>Olá, ${nome}!</h2><p>Seu código de verificação é: <strong style="font-size: 24px; color: #2c3e50;">${codigo}</strong></p><p>Digite este código na tela para liberar seu acesso.</p>`
            }).then(() => {
                console.log(`✅ Sucesso: Código enviado para ${email}!`);
            }).catch((erroEmail) => {
                console.error(`❌ ERRO FATAL AO ENVIAR CÓDIGO:`, erroEmail.message);
            });

            res.status(201).json({ mensagem: "Verifique seu e-mail!" });
        });
    } catch (erro) { res.status(500).json({ erro: "Erro interno." }); }
});

// MUDANÇA 3: A Nova Rota que verifica se o código digitado está certo
app.post('/api/verificar', (req, res) => {
    const { email, codigo } = req.body;
    
    db.get(`SELECT id, codigo_verificacao FROM usuarios WHERE email = ?`, [email], (err, usuario) => {
        if (!usuario) return res.status(400).json({ erro: "Usuário não encontrado." });
        
        if (usuario.codigo_verificacao === codigo) {
            // Se acertou, muda o status para 'verificado'
            db.run(`UPDATE usuarios SET status = 'verificado' WHERE id = ?`, [usuario.id]);
            res.json({ mensagem: "Conta ativada com sucesso!" });
        } else {
            res.status(400).json({ erro: "Código inválido." });
        }
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    db.get(`SELECT * FROM usuarios WHERE email = ?`, [email], async (err, usuario) => {
        if (!usuario) return res.status(400).json({ erro: "Usuário não encontrado." });
        
        // MUDANÇA 4: A Trava de Segurança no Login
        if (usuario.status !== 'verificado') {
            return res.status(403).json({ erro: "Você precisa verificar seu e-mail antes de entrar." });
        }

        const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
        if (!senhaCorreta) return res.status(400).json({ erro: "Senha incorreta." });
        
        const token = jwt.sign({ id: usuario.id, nome: usuario.nome, segmento: usuario.segmento }, CHAVE_SECRETA, { expiresIn: '2h' });
        res.json({ token: token });
    });
});

app.get('/api/alertas', verificarCracha, (req, res) => {
    db.all("SELECT * FROM leis_analisadas WHERE usuario_id = ? ORDER BY data_analise DESC LIMIT 10", [req.usuario.id], (err, linhas) => {
        res.json(linhas || []);
    });
});

app.delete('/api/limpar', verificarCracha, (req, res) => {
    db.run(`DELETE FROM leis_analisadas WHERE usuario_id = ?`, [req.usuario.id], function(err) {
        if (err) return res.status(500).json({ erro: "Erro ao limpar." });
        res.json({ mensagem: "Histórico limpo!" });
    });
});

app.post('/api/sincronizar', verificarCracha, async (req, res) => {
    if (estaSincronizando) {
        console.log("⚠️ Sincronização recusada: Já existe uma busca em em andamento.");
        return res.status(429).json({ erro: "O robô já está trabalhando. Aguarde a conclusão." });
    }

    estaSincronizando = true;
    console.log(`\n▶️ INICIANDO SINCRONIZAÇÃO (Usuário: ${req.usuario.nome})`);
    
    // 1. BUSCA O EMAIL DO USUÁRIO UMA ÚNICA VEZ NO INÍCIO DO PROCESSO
    db.get(`SELECT email FROM usuarios WHERE id = ?`, [req.usuario.id], async (err, donoDaConta) => {
        if (err || !donoDaConta || !donoDaConta.email) {
            console.error("❌ Erro: Não foi possível encontrar o e-mail do usuário logado.");
            estaSincronizando = false;
            return res.status(400).json({ erro: "Usuário não encontrado ou sem e-mail válido." });
        }

        try {
            const resposta = await axios.get('https://dadosabertos.camara.leg.br/api/v2/proposicoes?ordem=DESC&ordenarPor=id&itens=5');
            const leis = resposta.data.dados;
            let novasLeisProcessadas = 0;

            for (const lei of leis) {
                const jaExiste = await new Promise((resolve) => {
                    db.get(`SELECT id_lei FROM leis_analisadas WHERE id_lei = ? AND usuario_id = ?`, 
                    [lei.id.toString(), req.usuario.id], (err, row) => resolve(row !== undefined));
                });

                if (!jaExiste) {
                    novasLeisProcessadas++;
                    const prompt = `Aja como um advogado consultivo. Leia esta nova lei: "${lei.ementa}". Avalie impacto no segmento: ${req.usuario.segmento}. Retorne SÓ UM JSON: {"impacto": "Alto" ou "Baixo", "resumo_explicativo": "Explique em 1 frase"}`;

                    // Valor padrão caso ocorra o erro de cota 429
                    let analise = { impacto: "Baixo", resumo_explicativo: "Não foi possível analisar com a IA devido ao limite de requisições." };
                    
                    try {
                        console.log(`[3/4] 🧠 Enviando lei ${lei.id} para a IA analisar...`);
                        const respostaIA = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
                        const textoLimpo = respostaIA.text.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
                        
                        const dadosIAParsed = JSON.parse(textoLimpo);
                        
                        // 2. NORMALIZAÇÃO À PROVA DE FALHAS (Evita problemas com maiúsculas/minúsculas)
                        if (dadosIAParsed.impacto) {
                            const imp = dadosIAParsed.impacto.toString().toLowerCase().trim();
                            analise.impacto = imp.includes('alto') ? "Alto" : "Baixo";
                        }
                        if (dadosIAParsed.resumo_explicativo) {
                            analise.resumo_explicativo = dadosIAParsed.resumo_explicativo;
                        }
                        
                        console.log(`✅ Lei ${lei.id} analisada com sucesso pela IA. Resultado: ${analise.impacto}`);
                    } catch (e) { 
                        console.error(`⚠️ Falha na IA para a lei ${lei.id} (Usando predefinição de Baixo Impacto):`, e.message); 
                    }

                    // Salva no banco de dados com segurança
                    await new Promise((resolve) => {
                        db.run(`INSERT INTO leis_analisadas (id_lei, ementa, impacto, resumo_ia, usuario_id) VALUES (?, ?, ?, ?, ?)`,
                        [lei.id.toString(), lei.ementa, analise.impacto, analise.resumo_explicativo, req.usuario.id], resolve);
                    });

                    // 3. DISPARO DE E-MAIL BLINDADO COM AWAIT E TRATAMENTO DE ERROS FÍSICOS
                    if (analise.impacto === "Alto" || analise.impacto === "Baixo") {
                        try {
                            console.log(`📧 Despachando e-mail de alerta da lei ${lei.id} para ${donoDaConta.email}...`);
                            
                            await carteiro.sendMail({
                                from: process.env.EMAIL_REMETENTE, // Puxa do .env de forma segura
                                to: donoDaConta.email,
                                subject: `🚨 Alerta: Proposição ${lei.id} (${analise.impacto} Impacto)`,
                                html: `
                                    <h2 style="color: #2c3e50;">Alerta Legislativo</h2>
                                    <p>Olá, <strong>${req.usuario.nome}</strong>,</p>
                                    <p>O robô identificou uma nova lei com impacto classificado como <strong>${analise.impacto}</strong> para o seu segmento: <strong>${req.usuario.segmento}</strong>.</p>
                                    <div style="background: #f8f9fa; padding: 15px; border-left: 4px solid #34495e; margin-top: 10px;">
                                        <p><strong>Resumo Corretivo da IA:</strong><br>${analise.resumo_explicativo}</p>
                                    </div>
                                `
                            });
                            
                            console.log(`✅ Sucesso: Mensagem da lei ${lei.id} enviada e confirmada pelos servidores de e-mail.`);
                        } catch (erroEmail) {
                            console.error(`❌ Erro físico no envio do e-mail para a lei ${lei.id}:`, erroEmail.message);
                        }
                    }

                    console.log(`⏳ Aguardando 10 segundos para proteger a API do Google...`);
                    await esperar(10000); 
                }
            }
            res.json({ novas: novasLeisProcessadas });
        } catch (erro) {
            console.error("❌ Erro crítico na esteira de sincronização:", erro.message);
            res.status(500).json({ erro: "Erro interno ao processar a sincronização." });
        } finally {
            estaSincronizando = false;
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    inicializarBanco(); // O banco só tenta abrir agora
});