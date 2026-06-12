require('dotenv').config();
const axios = require('axios');
const ExcelJS = require('exceljs');
const { GoogleGenAI } = require('@google/genai');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer'); // Importa o enviador de e-mail

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = new sqlite3.Database('./historico_leis.db');

const SEGMENTO_CLIENTE = "Qualquer área de negócio (avalie se afeta impostos, leis trabalhistas ou regras de empresas em geral)";

// Garante que a tabela de memória existe
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS leis_analisadas (
        id_lei TEXT PRIMARY KEY,
        ementa TEXT,
        impacto TEXT,
        resumo_ia TEXT,
        data_analise DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

async function analisarComIA(textoLei) {
    const prompt = `
        Aja como um advogado consultivo sênior. 
        Leia o resumo desta nova lei: "${textoLei}".
        Avalie se isso impacta uma empresa do seguinte segmento: ${SEGMENTO_CLIENTE}.
        
        Retorne ESTRITAMENTE um JSON válido com esta estrutura exata, sem nenhuma outra palavra:
        {"impacto": "Alto" ou "Baixo", "resumo_explicativo": "Explique o motivo em 1 frase"}
    `;

    try {
        const resposta = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        const textoLimpo = resposta.text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(textoLimpo);
    } catch (erro) {
        return { impacto: "Baixo", resumo_explicativo: "Não foi possível analisar com a IA." };
    }
}

function verificarSeJaFoiLida(idLei) {
    return new Promise((resolve) => {
        db.get(`SELECT id_lei FROM leis_analisadas WHERE id_lei = ?`, [idLei], (err, row) => {
            resolve(row !== undefined);
        });
    });
}

// Nova função para realizar o envio do e-mail com o anexo
async function enviarEmailComAnexo(caminhoArquivo, totalAlertas) {
    // Configura o transportador (ajustado para o Gmail, mas funciona com outros)
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_REMETENTE,
            pass: process.env.EMAIL_SENHA
        },
        tls: {
            rejectUnauthorized: false // <--- ADICIONE ESTA LINHA (com a vírgula depois da chave do auth!)
        }
    });

    const mensagem = {
        from: `"Robô de Monitoramento Legislativo" <${process.env.EMAIL_REMETENTE}>`,
        to: process.env.EMAIL_DESTINATARIO,
        subject: `🚨 Alerta Legislativo: ${totalAlertas} Novas Atualizações Críticas`,
        text: `Olá,\n\nO robô de monitoramento identificou novas atualizações legislativas que podem impactar os negócios.\n\nO relatório gerado pela Inteligência Artificial está anexado a este e-mail.\n\nAtenciosamente,\nRobô Legislativo.`,
        attachments: [
            {
                filename: 'Relatorio_Alertas_Criticos.xlsx',
                path: caminhoArquivo
            }
        ]
    };

    console.log('5. Conectando ao servidor de e-mail e enviando...');
    await transporter.sendMail(mensagem);
    console.log('6. SUCESSO! E-mail enviado para o destinatário com o Excel anexado.');
}

async function roboCompleto() {
    console.log('1. Iniciando o robô completo...');
    const novasLeisImpactantes = [];

    try {
        console.log('2. Buscando as últimas leis na Câmara...');
        const resposta = await axios.get('https://dadosabertos.camara.leg.br/api/v2/proposicoes?ordem=DESC&ordenarPor=id&itens=5');
        const leis = resposta.data.dados;

        console.log('3. Filtrando novidades e consultando a IA...');
        for (const lei of leis) {
            const jaConhece = await verificarSeJaFoiLida(lei.id.toString());

            if (jaConhece) {
                console.log(`[IGNORADA] Lei ID ${lei.id} já está na memória.`);
                continue;
            }

            console.log(`[NOVA LEI] Analisando lei ID: ${lei.id}...`);
            const analise = await analisarComIA(lei.ementa);
            
            // Salva na memória SQL para não reprocessar amanhã
            db.run(`INSERT INTO leis_analisadas (id_lei) VALUES (?)`, [lei.id.toString()]);

            // Forçamos o push para testar o fluxo do e-mail no primeiro disparo
            novasLeisImpactantes.push({
                id: lei.id,
                ementa: lei.ementa,
                resumo: analise.resumo_explicativo
            });
        }

        // 4. Se houver leis novas, gera o Excel e dispara o e-mail
        if (novasLeisImpactantes.length > 0) {
            console.log('4. Gerando a planilha Excel...');
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Alertas');
            
            worksheet.columns = [
                { header: 'ID da Lei', key: 'id', width: 15 },
                { header: 'Texto Original', key: 'ementa', width: 60 },
                { header: 'Análise da IA', key: 'resumo', width: 60 }
            ];

            novasLeisImpactantes.forEach(lei => worksheet.addRow(lei));
            
            const caminhoExcel = './Alertas_Finais.xlsx';
            await workbook.xlsx.writeFile(caminhoExcel);

            // Chama a função de e-mail enviando o arquivo gerado
            await enviarEmailComAnexo(caminhoExcel, novasLeisImpactantes.length);
        } else {
            console.log('4. Varredura concluída. Nenhuma novidade encontrada para enviar.');
        }

    } catch (erro) {
        console.log('❌ Ocorreu um erro no sistema:', erro.message);
    }
}

roboCompleto();