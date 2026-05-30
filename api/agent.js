
import { URLSearchParams } from 'url';

// Helper response formatter
const jsonResponse = (res, status, data) => {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(data);
};

// --------------------------------------------------
// TOKENS & BACKEND CONFIGURATION
// --------------------------------------------------
const EMAIL_ADMIN = process.env.EMAIL_ADMIN || 'admin@admin.com';
const PASSWORD = process.env.PASSWORD || 'admin';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

// Validation untuk environment variables yang critical
const validateEnv = () => {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!VERCEL_TOKEN) missing.push('VERCEL_TOKEN');
  
  if (missing.length > 0) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    return { valid: false, missing };
  }
  return { valid: true };
};

// In-memory/simple hash mock token validation
const BACKEND_SECRET_TOKEN = 'secure_agent_session_token_validation_key_2026';

export default async function handler(req, res) {
  // Hanya menerima metode POST
  if (req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'Method not allowed' });
  }

  const { action } = req.body;

  // 1. SISTEM LOGIN
  if (action === 'login') {
    const { email, password } = req.body;
    if (email === EMAIL_ADMIN && password === PASSWORD) {
      return jsonResponse(res, 200, { 
        success: true, 
        token: BACKEND_SECRET_TOKEN,
        message: 'Login berhasil.' 
      });
    }
    return jsonResponse(res, 401, { success: false, error: 'Email atau password salah!' });
  }

  // 2. VALIDASI LOGIN UNTUK TOOL DAN CHAT AGENT
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${BACKEND_SECRET_TOKEN}`) {
    return jsonResponse(res, 401, { success: false, error: 'Unauthorized. Silakan login terlebih dahulu.' });
  }

  // 3. APPLY CHANGES CONTROLLER (DIPANGGIL SETELAH USER MENGONFIRMASI DI MODAL PREVIEW)
  if (action === 'apply_changes') {
    const { proposal, context } = req.body;
    if (!proposal || !proposal.path || !proposal.proposedCode) {
      return jsonResponse(res, 400, { success: false, error: 'Data proposal tidak lengkap.' });
    }

    try {
      const activeRepo = context.activeRepo || proposal.repo;
      if (!activeRepo) {
        return jsonResponse(res, 400, { success: false, error: 'Repository aktif tidak terdeteksi.' });
      }

      // Gunakan GitHub API untuk menyimpan/edit file
      const commitRes = await writeGitHubFile(
        activeRepo, 
        proposal.path, 
        proposal.proposedCode, 
        proposal.commitMessage || 'Auto Fix oleh AI Dev Agent'
      );

      let vercelDeployment = null;
      // Jika project vercel aktif dikonfigurasi, jalankan redeploy otomatis
      if (context.activeProject) {
        vercelDeployment = await triggerVercelRedeploy(context.activeProject);
      }

      return jsonResponse(res, 200, {
        success: true,
        commit: commitRes,
        vercelStatus: vercelDeployment ? vercelDeployment.status : 'Tidak ada project Vercel yang terhubung',
        updatedContext: {
          ...context,
          activeFile: proposal.path
        }
      });
    } catch (err) {
      return jsonResponse(res, 500, { success: false, error: err.message });
    }
  }

  // 4. CHAT AGENT & TOOLS ENGINE (INTEGRATED WITH OPENAI FUNCTION CALLING)
  if (action === 'chat') {
    // Validasi environment variables sebelum mencoba chat
    const envCheck = validateEnv();
    if (!envCheck.valid) {
      return jsonResponse(res, 500, { 
        success: false, 
        error: `❌ Server Configuration Error: Missing ${envCheck.missing.join(', ')}. Hubungi administrator.` 
      });
    }

    const { message, context, history } = req.body;

    // Kumpulan tool runs log untuk diumpankan balik ke tampilan frontend
    const toolRuns = [];

    try {
      // Konstruksi System Message agar AI mengerti context state yang sedang berlangsung
      const systemMessage = {
        role: 'system',
        content: `Anda adalah AI Dev Agent profesional dengan antarmuka ChatGPT modern.
Tugas Anda membantu developer mengelola repositori GitHub dan mendeploy ke Vercel.

Konteks Memori Aktif Saat Ini:
- Repositori GitHub aktif: ${context.activeRepo || 'Belum dipilih'}
- File terakhir dibuka: ${context.activeFile || 'Belum dibuka'}
- Folder terakhir dibuka: ${context.activeFolder || 'Belum dibuka'}
- Project Vercel aktif: ${context.activeProject || 'Belum dihubungkan'}

Aturan Perilaku:
1. Pahami instruksi user secara otonom tanpa memerlukan command prefix.
2. Jika user ingin menganalisis atau memperbaiki kesalahan build ("fix error"):
   - Panggil tool 'autoFixFlow' untuk mengambil logs, menganalisisnya, mendeteksi file penyebab, dan memberikan kode rekomendasi baru.
3. Selalu sinkronkan context memori yang relevan di setiap fungsi tool yang Anda panggil.
4. Berikan penjelasan respons akhir yang padat, ramah, dan solutif.`
      };

      // Siapkan payload pesan untuk OpenAI
      const messages = [systemMessage, ...history, { role: 'user', content: message }];

      // Definisi OpenAI Tool Specifications (Function Calling)
      const tools = [
        // GitHub Tools
        {
          type: 'function',
          function: {
            name: 'listRepos',
            description: 'Mengambil daftar repositori GitHub yang tersedia.',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'selectRepo',
            description: 'Memilih atau mengaktifkan repositori GitHub untuk dikerjakan.',
            parameters: {
              type: 'object',
              properties: {
                repoName: { type: 'string', description: 'Nama repositori GitHub yang ingin dipilih.' }
              },
              required: ['repoName']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'listFiles',
            description: 'Membaca daftar file dalam repositori aktif atau folder tertentu.',
            parameters: {
              type: 'object',
              properties: {
                folderPath: { type: 'string', description: 'Path folder relatif, kosongkan untuk root.' }
              }
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'readFile',
            description: 'Membaca dan menampilkan isi konten sebuah file dari repositori aktif.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Path relatif dari file yang ingin dibuka.' }
              },
              required: ['filePath']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'writeFile',
            description: 'Menulis, mengedit, atau memperbarui kode langsung di dalam file pada repositori aktif.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Path relatif tujuan file.' },
                content: { type: 'string', description: 'Isi lengkap kode yang baru.' },
                commitMessage: { type: 'string', description: 'Pesan deskripsi perubahan untuk git commit.' }
              },
              required: ['filePath', 'content']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'renameFile',
            description: 'Mengubah nama file di repositori aktif.',
            parameters: {
              type: 'object',
              properties: {
                oldPath: { type: 'string', description: 'Nama/path file saat ini.' },
                newPath: { type: 'string', description: 'Nama/path file baru.' }
              },
              required: ['oldPath', 'newPath']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'deleteFile',
            description: 'Menghapus file di repositori aktif.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Path file yang ingin dihapus.' }
              },
              required: ['filePath']
            }
          }
        },
        // Vercel Tools
        {
          type: 'function',
          function: {
            name: 'listProjects',
            description: 'Mengambil daftar project deployment di Vercel.',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'selectVercelProject',
            description: 'Memilih project Vercel aktif saat ini.',
            parameters: {
              type: 'object',
              properties: {
                projectId: { type: 'string', description: 'ID atau nama project Vercel.' }
              },
              required: ['projectId']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'deployProject',
            description: 'Memulai proses trigger deploy atau re-deploy project aktif di Vercel.',
            parameters: {
              type: 'object',
              properties: {
                projectId: { type: 'string', description: 'ID project Vercel.' }
              },
              required: ['projectId']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'getDeployments',
            description: 'Melihat riwayat deployment dari project Vercel aktif.',
            parameters: {
              type: 'object',
              properties: {
                projectId: { type: 'string', description: 'ID project Vercel.' }
              },
              required: ['projectId']
            }
          }
        },
        // Auto Fix Tool Flow
        {
          type: 'function',
          function: {
            name: 'autoFixFlow',
            description: 'Mengambil log Vercel, menganalisis error build, mencari penyebabnya, dan menyusun kode perbaikan.',
            parameters: { type: 'object', properties: {} }
          }
        }
      ];

      // Call OpenAI API
      const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          tools,
          tool_choice: 'auto'
        })
      });

      const aiData = await aiResponse.json();
      if (aiData.error) {
        return jsonResponse(res, 500, { success: false, error: `OpenAI API Error: ${aiData.error.message}` });
      }

      const choice = aiData.choices[0];
      let responseText = choice.message.content || '';
      let updatedContext = { ...context };
      let previewChanges = null;

      // Cek apakah model meminta pemanggilan Tool (Function Call)
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        const toolCall = choice.message.tool_calls[0];
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        try {
          // ROUTING RUN TOOL
          if (toolName === 'listRepos') {
            const repos = await listGitHubRepos();
            responseText = `Berikut adalah daftar repositori Anda:\n\n` + 
              repos.map(r => `- **${r.name}** (stars: ${r.stargazers_count})`).join('\n') +
              `\n\nSilakan pilih salah satu dengan instruksi: *"Pilih repo [nama_repo]"*`;
            toolRuns.push({ name: 'listRepos', status: 'success', details: `Ditemukan ${repos.length} repositori.` });
          } 
          
          else if (toolName === 'selectRepo') {
            updatedContext.activeRepo = args.repoName;
            responseText = `Repositori aktif sekarang diset ke **${args.repoName}**. Anda sekarang dapat menjalankan perintah seperti membacanya atau melihat strukturnya.`;
            toolRuns.push({ name: 'selectRepo', status: 'success', details: `Repo diset ke ${args.repoName}` });
          }

          else if (toolName === 'listFiles') {
            const currentRepo = updatedContext.activeRepo;
            if (!currentRepo) {
              responseText = "⚠️ Maaf, Anda belum memilih repositori aktif. Silakan pilih terlebih dahulu.";
              toolRuns.push({ name: 'listFiles', status: 'error', details: 'No active repository selected.' });
            } else {
              const files = await listGitHubFiles(currentRepo, args.folderPath || '');
              responseText = `Berikut isi folder \`${args.folderPath || '/'}\` pada repositori **${currentRepo}**:\n\n` +
                files.map(f => `- ${f.type === 'dir' ? '📁' : '📄'} **${f.name}**`).join('\n');
              updatedContext.activeFolder = args.folderPath || '/';
              toolRuns.push({ name: 'listFiles', status: 'success', details: `Membaca ${files.length} file/folder.` });
            }
          }

          else if (toolName === 'readFile') {
            const currentRepo = updatedContext.activeRepo;
            if (!currentRepo) {
              responseText = "⚠️ Anda harus memilih repositori aktif sebelum dapat membaca file.";
              toolRuns.push({ name: 'readFile', status: 'error', details: 'No active repository selected.' });
            } else {
              const fileContent = await readGitHubFile(currentRepo, args.filePath);
              responseText = `Berhasil membuka file \`${args.filePath}\` dari repositori **${currentRepo}**:\n\n\`\`\`javascript\n${fileContent}\n\`\`\``;
              updatedContext.activeFile = args.filePath;
              toolRuns.push({ name: 'readFile', status: 'success', details: `Membaca file ${args.filePath}` });
            }
          }

          else if (toolName === 'writeFile') {
            const currentRepo = updatedContext.activeRepo;
            if (!currentRepo) {
              responseText = "⚠️ Anda harus mengaktifkan sebuah repositori terlebih dahulu.";
              toolRuns.push({ name: 'writeFile', status: 'error', details: 'No active repository selected.' });
            } else {
              // Jika menulis file, tampilkan preview modal konfirmasi perubahan ke user
              const original = await readGitHubFile(currentRepo, args.filePath).catch(() => '');
              previewChanges = {
                repo: currentRepo,
                path: args.filePath,
                originalCode: original,
                proposedCode: args.content,
                commitMessage: args.commitMessage || `Memperbarui ${args.filePath}`
              };
              responseText = `Saya telah menyusun rancangan perubahan untuk file \`${args.filePath}\`. Silakan verifikasi perubahan di bawah dan setujui untuk menyimpan ke GitHub.`;
              toolRuns.push({ name: 'writeFile', status: 'success', details: `Mengajukan draf perubahan untuk ${args.filePath}` });
            }
          }

          else if (toolName === 'renameFile') {
            const currentRepo = updatedContext.activeRepo;
            if (!currentRepo) throw new Error("No active repository.");
            await renameGitHubFile(currentRepo, args.oldPath, args.newPath);
            responseText = `Berhasil mengubah nama file dari \`${args.oldPath}\` menjadi \`${args.newPath}\`.`;
            toolRuns.push({ name: 'renameFile', status: 'success', details: `Rename dari ${args.oldPath} ke ${args.newPath}` });
          }

          else if (toolName === 'deleteFile') {
            const currentRepo = updatedContext.activeRepo;
            if (!currentRepo) throw new Error("No active repository.");
            await deleteGitHubFile(currentRepo, args.filePath);
            responseText = `File \`${args.filePath}\` berhasil dihapus dari repositori aktif.`;
            toolRuns.push({ name: 'deleteFile', status: 'success', details: `Menghapus file ${args.filePath}` });
          }

          else if (toolName === 'listProjects') {
            const projects = await listVercelProjects();
            responseText = `Berikut daftar project Vercel Anda:\n\n` +
              projects.map(p => `- **${p.name}** (Status: ${p.framework || 'Node.js'}, Terakhir update: ${new Date(p.updatedAt).toLocaleDateString()})`).join('\n') +
              `\n\nInstruksikan *"Pilih project vercel [nama_project]"* untuk menghubungkannya.`;
            toolRuns.push({ name: 'listProjects', status: 'success', details: `Ditemukan ${projects.length} project.` });
          }

          else if (toolName === 'selectVercelProject') {
            updatedContext.activeProject = args.projectId;
            responseText = `Project Vercel aktif sekarang diset ke **${args.projectId}**.`;
            toolRuns.push({ name: 'selectVercelProject', status: 'success', details: `Project diset ke ${args.projectId}` });
          }

          else if (toolName === 'deployProject') {
            const deploy = await triggerVercelRedeploy(args.projectId);
            responseText = `Redeploy berhasil dijalankan pada project **${args.projectId}**. Status build saat ini: **${deploy.status}**.`;
            toolRuns.push({ name: 'deployProject', status: 'success', details: `Deploy ID: ${deploy.id}` });
          }

          else if (toolName === 'getDeployments') {
            const list = await getVercelDeployments(args.projectId);
            responseText = `Berikut riwayat deployment untuk project **${args.projectId}**:\n\n` +
              list.slice(0, 5).map(d => `- **${d.uid}** | Status: *${d.state}* | URL: https://${d.url}`).join('\n');
            toolRuns.push({ name: 'getDeployments', status: 'success', details: `Membaca ${list.length} deployments` });
          }

          // FLOW AUTO FIX INTEGRASI PENUH
          else if (toolName === 'autoFixFlow') {
            const currentProject = updatedContext.activeProject;
            const currentRepo = updatedContext.activeRepo;

            if (!currentProject || !currentRepo) {
              responseText = "⚠️ **Context Memory Belum Lengkap!**\n\nUntuk mendiagnosis kesalahan secara otomatis, mohon pilih repositori GitHub dan project Vercel aktif Anda terlebih dahulu.";
              toolRuns.push({ name: 'autoFixFlow', status: 'error', details: 'Missing repository or Vercel config.' });
            } else {
              // 1. Dapatkan log deployment terakhir yang error/failed
              const deployments = await getVercelDeployments(currentProject);
              const latest = deployments[0]; // ambil yang terbaru

              if (!latest) {
                responseText = `Tidak ditemukan riwayat deployment pada project Vercel: **${currentProject}**.`;
                toolRuns.push({ name: 'autoFixFlow', status: 'error', details: 'No deployments found.' });
              } else {
                toolRuns.push({ name: 'autoFixFlow', status: 'success', details: `Membaca deployment log ID: ${latest.uid}` });
                
                // Ambil deployment logs mentah
                const rawLogs = await getVercelDeploymentLogs(latest.uid);
                
                // Minta bantuan model dalam server untuk mengisolasi error build
                const analyzePrompt = `Berikut adalah log build error dari Vercel:
\`\`\`
${rawLogs}
\`\`\`

Tolong identifikasi file penyebab utama kesalahan (misalnya: index.js, package.json, plugins/group.js, dsb.) dan berikan rekomendasi perbaikan kodenya. Format respons harus JSON dengan properti 'path' (file path) dan 'newCode' (kode perbaikan yang disarankan).`;

                const isolateResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                  },
                  body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: analyzePrompt }],
                    response_format: { type: 'json_object' }
                  })
                });

                const rawAnalysis = await isolateResponse.json();
                const analysisResult = JSON.parse(rawAnalysis.choices[0].message.content);

                // 2. Baca file original di GitHub
                const originalCodeInRepo = await readGitHubFile(currentRepo, analysisResult.path).catch(() => '');

                // 3. Masukkan ke buffer preview modal
                previewChanges = {
                  repo: currentRepo,
                  path: analysisResult.path,
                  originalCode: originalCodeInRepo,
                  proposedCode: analysisResult.newCode,
                  commitMessage: `fix(build): memperbaiki kesalahan build error pada ${analysisResult.path}`
                };

                responseText = `🚨 **Error Build Berhasil Diidentifikasi!**\n\n- **Project:** \`${currentProject}\`\n- **Penyebab:** Kesalahan pada berkas \`${analysisResult.path}\`\n- **Rekomendasi:** Kode telah dianalisis dan siap untuk diterapkan.`;
                toolRuns.push({ name: 'autoFixFlow', status: 'success', details: `Menyusun usulan perbaikan pada ${analysisResult.path}` });
              }
            }
          }

        } catch (toolError) {
          responseText = `⚠️ Terjadi kesalahan saat menjalankan fungsi \`${toolName}\`: ${toolError.message}`;
          toolRuns.push({ name: toolName, status: 'error', details: toolError.message });
        }
      }

      return jsonResponse(res, 200, {
        success: true,
        responseText,
        toolRuns,
        updatedContext,
        previewChanges
      });

    } catch (chatErr) {
      return jsonResponse(res, 500, { success: false, error: chatErr.message });
    }
  }

  return jsonResponse(res, 400, { error: 'Unknown action specified' });
}

// --------------------------------------------------
// GITHUB API CORE INTEGRATIONS
// --------------------------------------------------
async function listGitHubRepos() {
  const response = await fetch('https://api.github.com/user/repos?sort=updated&per_page=10', {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AI-Dev-Agent-Builder'
    }
  });
  if (!response.ok) throw new Error(`GitHub list repos failed: ${response.statusText}`);
  return response.json();
}

async function listGitHubFiles(repo, path = '') {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AI-Dev-Agent-Builder'
    }
  });
  if (!response.ok) throw new Error(`Gagal membuka file list GitHub: ${response.statusText}`);
  return response.json();
}

async function readGitHubFile(repo, path) {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AI-Dev-Agent-Builder'
    }
  });
  if (!response.ok) throw new Error(`Gagal membaca file dari GitHub: ${response.statusText}`);
  const data = await response.json();
  const buff = Buffer.from(data.content, 'base64');
  return buff.toString('utf-8');
}

async function writeGitHubFile(repo, path, content, commitMessage = 'Updated by AI') {
  // Ambil SHA file jika file sudah ada (untuk keperluan overwrite/update)
  let sha = undefined;
  try {
    const checkResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AI-Dev-Agent-Builder'
      }
    });
    if (checkResponse.ok) {
      const fileData = await checkResponse.json();
      sha = fileData.sha;
    }
  } catch (e) {
    // Abaikan jika file belum pernah ada (maka sha undefined, akan membuat file baru)
  }

  const base64Content = Buffer.from(content).toString('base64');
  const body = {
    message: commitMessage,
    content: base64Content,
    sha: sha
  };

  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AI-Dev-Agent-Builder'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errMsg = await response.text();
    throw new Error(`Gagal menulis file GitHub: ${errMsg}`);
  }
  return response.json();
}

async function renameGitHubFile(repo, oldPath, newPath) {
  // GitHub REST API tidak memiliki endpoint rename langsung, 
  // Proses rename dilakukan dengan membaca isi file lama -> menulis ke file baru -> menghapus file lama.
  const content = await readGitHubFile(repo, oldPath);
  await writeGitHubFile(repo, newPath, content, `rename: ${oldPath} -> ${newPath}`);
  await deleteGitHubFile(repo, oldPath);
}

async function deleteGitHubFile(repo, path) {
  // Perlu SHA untuk konfirmasi penghapusan di GitHub API
  const checkResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AI-Dev-Agent-Builder'
    }
  });
  if (!checkResponse.ok) throw new Error(`File target tidak ditemukan untuk dihapus.`);
  const fileData = await checkResponse.json();

  const body = {
    message: `delete: menghapus file ${path}`,
    sha: fileData.sha
  };

  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AI-Dev-Agent-Builder'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`Gagal menghapus file di GitHub.`);
  return response.json();
}

// --------------------------------------------------
// VERCEL API CORE INTEGRATIONS
// --------------------------------------------------
async function listVercelProjects() {
  const response = await fetch('https://api.vercel.com/v9/projects', {
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`
    }
  });
  if (!response.ok) throw new Error(`Vercel list projects failed: ${response.statusText}`);
  const data = await response.json();
  return data.projects || [];
}

async function triggerVercelRedeploy(projectId) {
  // Ambil deployment terakhir untuk menemukan target deploy config
  const deployments = await getVercelDeployments(projectId);
  if (deployments.length === 0) {
    throw new Error('Tidak ada riwayat deployment pada project Vercel ini.');
  }

  const response = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: projectId,
      deploymentId: deployments[0].uid
    })
  });

  if (!response.ok) throw new Error(`Vercel trigger redeploy failed: ${response.statusText}`);
  return response.json();
}

async function getVercelDeployments(projectId) {
  const response = await fetch(`https://api.vercel.com/v6/deployments?projectId=${projectId}`, {
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`
    }
  });
  if (!response.ok) throw new Error(`Vercel get deployments failed: ${response.statusText}`);
  const data = await response.json();
  return data.deployments || [];
}

async function getVercelDeploymentLogs(deploymentId) {
  // Mengambil deployment logs menggunakan standard Vercel log streams
  const response = await fetch(`https://api.vercel.com/v2/deployments/${deploymentId}/events?limit=40`, {
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`
    }
  });
  if (!response.ok) throw new Error(`Gagal memuat log dari Vercel.`);
  const logs = await response.json();
  // Satukan pesan logs menjadi satu string
  return logs.map(l => l.text).join('\n');
}
