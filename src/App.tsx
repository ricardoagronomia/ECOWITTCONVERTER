/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { 
  Upload, 
  Download, 
  CheckCircle, 
  AlertTriangle, 
  FileSpreadsheet,
  X,
  RefreshCw,
  Trash2,
  FileText
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';

type Status = 'idle' | 'processing' | 'completed' | 'failed';

interface ValidationLog {
  id: string;
  msg: string;
  type: 'success' | 'warning' | 'error';
  timestamp: string;
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [logs, setLogs] = useState<ValidationLog[]>([]);
  const [processedData, setProcessedData] = useState<any[]>([]);
  
  const sourceInputRef = useRef<HTMLInputElement>(null);

  const addLog = (msg: string, type: 'success' | 'warning' | 'error' = 'success') => {
    setLogs(prev => [
      {
        id: Math.random().toString(36).substr(2, 9),
        msg,
        type,
        timestamp: new Date().toLocaleTimeString()
      },
      ...prev
    ]);
  };

  const parseNumber = (val: any): number | null => {
    if (val === undefined || val === null || val === '') return null;
    // Handle strings with units or special chars
    const cleaned = String(val).replace(/[^\d.-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSourceFile(file);
    addLog(`Arquivo Ecowitt carregado: ${file.name}`, 'success');
    setStatus('idle');
    setProcessedData([]);
  };

  const processEcowittData = async () => {
    if (!sourceFile) {
      addLog('Nenhum arquivo selecionado.', 'error');
      return;
    }

    setStatus('processing');
    addLog('Iniciando conversão Ecowitt...', 'success');

    try {
      const data = await sourceFile.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      
      // Read all rows as array of arrays to handle the double header
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
      
      if (rows.length < 2) {
        throw new Error('Arquivo muito curto ou sem dados.');
      }

      // Skip first row (categories), use second row as headers
      const categories = rows[0] as string[];
      const headers = rows[1] as string[];
      const dataRows = rows.slice(2);

      // Rule: First column (index 0) is ALWAYS Time (even if header is empty)
      const timeIdx = 0;
      
      // Find other column indices with flexible mapping
      // 1. Rain (Daily(mm))
      const rainIdx = headers.findIndex(h => h?.includes('Daily(mm)'));

      // 2. Temperature (Reference: Feels Like(℃))
      let tempIdx = -1;
      const feelsLikeIdx = headers.findIndex(h => h?.includes('Feels Like(℃)'));
      
      if (feelsLikeIdx !== -1) {
        // User instruction: Use Feels Like or the one immediately before it
        // Usually raw Outdoor Temp is right before Feels Like
        if (feelsLikeIdx > 0 && headers[feelsLikeIdx - 1]?.includes('Temperature(℃)')) {
          tempIdx = feelsLikeIdx - 1;
        } else {
          tempIdx = feelsLikeIdx;
        }
      } else {
        // Fallback to previous logic if Feels Like is not found
        tempIdx = headers.findIndex(h => h?.includes('Temperature(℃)') && !h?.includes('Indoor'));
      }

      // 3. Humidity (Closest to chosen Temperature)
      let humIdx = -1;
      if (tempIdx !== -1) {
        const humIndices = headers.map((h, i) => h?.includes('Humidity(%)') ? i : -1).filter(i => i !== -1);
        if (humIndices.length > 0) {
          // Find the one with minimum distance to tempIdx
          humIdx = humIndices.reduce((prev, curr) => 
            Math.abs(curr - tempIdx) < Math.abs(prev - tempIdx) ? curr : prev
          );
        }
      }

      // Validation check
      const missing = [];
      if (tempIdx === -1) missing.push('Temperature (Outdoor/Feels Like)');
      if (humIdx === -1) missing.push('Humidity (Outdoor)');
      if (rainIdx === -1) missing.push('Daily(mm)');

      if (missing.length > 0) {
        addLog(`Erro: Colunas não encontradas: ${missing.join(', ')}`, 'error');
        addLog(`Colunas detectadas: ${headers.map((h, i) => h || `[Vazia em ${i}]`).join(' | ')}`, 'warning');
        throw new Error('Mapeamento de sensores falhou.');
      }

      addLog(`Mapeamento concluído:`, 'success');
      addLog(`- Temp: "${headers[tempIdx]}" (Col ${tempIdx})`, 'success');
      addLog(`- Hum: "${headers[humIdx]}" (Col ${humIdx})`, 'success');
      addLog(`- Chuva: "${headers[rainIdx]}" (Col ${rainIdx})`, 'success');

      // Grouping logic
      const dailyGroups: Record<string, {
        rain: { val: number, time: number }[],
        temp: number[],
        hum: number[]
      }> = {};

      dataRows.forEach((row, idx) => {
        const timeVal = row[timeIdx];
        if (!timeVal) return;

        // Parse date (equivalent to pd.to_datetime with errors='coerce')
        const d = new Date(timeVal);
        if (isNaN(d.getTime())) return;
        
        const dateKey = d.toISOString().split('T')[0];
        const timestamp = d.getTime();

        if (!dailyGroups[dateKey]) {
          dailyGroups[dateKey] = { rain: [], temp: [], hum: [] };
        }

        const rain = parseNumber(row[rainIdx]);
        const temp = parseNumber(row[tempIdx]);
        const hum = parseNumber(row[humIdx]);

        if (rain !== null) dailyGroups[dateKey].rain.push({ val: rain, time: timestamp });
        if (temp !== null) dailyGroups[dateKey].temp.push(temp);
        if (hum !== null) dailyGroups[dateKey].hum.push(hum);
      });

      // Calculate aggregates
      const result = Object.entries(dailyGroups).map(([date, values]) => {
        // Rain logic: Get the value from the LAST record of the day to avoid carryover from previous day's midnight
        let rain_mm = 0;
        if (values.rain.length > 0) {
          const lastRecord = values.rain.reduce((prev, current) => 
            (prev.time > current.time) ? prev : current
          );
          rain_mm = lastRecord.val;
        }

        const tmax_c = values.temp.length > 0 ? Math.max(...values.temp) : null;
        const tmin_c = values.temp.length > 0 ? Math.min(...values.temp) : null;
        const tmean_c = values.temp.length > 0 
          ? values.temp.reduce((a, b) => a + b, 0) / values.temp.length 
          : null;
        const rh_mean = values.hum.length > 0 
          ? values.hum.reduce((a, b) => a + b, 0) / values.hum.length 
          : null;

        return {
          date,
          rain_mm: Number(rain_mm.toFixed(1)),
          tmax_c: tmax_c !== null ? Number(tmax_c.toFixed(1)) : '',
          tmin_c: tmin_c !== null ? Number(tmin_c.toFixed(1)) : '',
          tmean_c: tmean_c !== null ? Number(tmean_c.toFixed(1)) : '',
          rh_mean: rh_mean !== null ? Number(rh_mean.toFixed(1)) : ''
        };
      }).sort((a, b) => a.date.localeCompare(b.date));

      setProcessedData(result);
      addLog(`Processamento concluído: ${result.length} dias convertidos.`, 'success');
      setStatus('completed');

      // Auto-trigger download
      const ws = XLSX.utils.json_to_sheet(result, { 
        header: ['date', 'rain_mm', 'tmax_c', 'tmin_c', 'tmean_c', 'rh_mean'] 
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Dados Climáticos");
      XLSX.writeFile(wb, `Ecowitt_Convertido_${new Date().getTime()}.xlsx`);
      addLog('Download iniciado automaticamente.', 'success');

    } catch (error: any) {
      setStatus('failed');
      addLog(`Erro: ${error.message}`, 'error');
      console.error(error);
    }
  };

  const clearData = () => {
    setSourceFile(null);
    setProcessedData([]);
    setLogs([]);
    setStatus('idle');
    if (sourceInputRef.current) sourceInputRef.current.value = '';
    addLog('Sistema reiniciado.', 'success');
  };

  const Card = ({ children, title, className = "" }: { children: React.ReactNode, title: string, className?: string }) => (
    <div className={`bg-white border border-[#141414] p-6 mb-4 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] ${className}`}>
      <h2 className="text-sm font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
        <div className="w-2 h-2 bg-[#141414]"></div>
        {title}
      </h2>
      {children}
    </div>
  );

  const Button = ({ children, variant = 'primary', disabled = false, ...props }: any) => (
    <button 
      {...props}
      disabled={disabled}
      className={`px-6 py-3 font-bold transition-all border border-[#141414] flex items-center justify-center gap-2 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${
        variant === 'primary' 
          ? 'bg-[#141414] text-[#F5F5F5] hover:bg-[#E4E3E0] hover:text-[#141414] shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]' 
          : 'bg-transparent text-[#141414] hover:bg-[#E4E3E0] shadow-[2px_2px_0px_0px_rgba(20,20,20,1)]'
      }`}
      style={{ borderRadius: '0px' }}
    >
      {children}
    </button>
  );

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#141414] p-4 md:p-8 font-sans selection:bg-[#141414] selection:text-white">
      <header className="mb-12 border-b-2 border-[#141414] pb-6 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-5xl md:text-6xl font-black uppercase tracking-tighter leading-none">
            Ecowitt<span className="bg-[#141414] text-[#F5F5F5] px-2">Converter</span>
          </h1>
          <p className="text-sm font-bold mt-2 opacity-80 uppercase tracking-wider">
            Conversor de Dados Climáticos (CSV → XLSX)
          </p>
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[10px] font-mono uppercase bg-[#141414] text-white px-2 py-1 mb-1">
            Engine v3.0 (Pandas Logic)
          </div>
          <div className="text-xs font-mono uppercase flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status === 'processing' ? 'bg-yellow-500 animate-pulse' : status === 'completed' ? 'bg-green-500' : 'bg-gray-400'}`}></span>
            Status: {status}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-8">
          <Card title="1. Upload do Arquivo Ecowitt (CSV)">
            <div 
              className={`border-2 border-dashed border-[#141414] p-12 text-center transition-colors ${sourceFile ? 'bg-green-50' : 'hover:bg-[#E4E3E0]'}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) handleFileUpload({ target: { files: [file] } } as any);
              }}
            >
              {sourceFile ? (
                <div className="flex flex-col items-center">
                  <FileText className="mb-4 text-[#141414]" size={48} />
                  <p className="text-lg font-black uppercase">{sourceFile.name}</p>
                  <p className="text-xs opacity-60 mt-1">{(sourceFile.size / 1024).toFixed(1)} KB</p>
                  <button 
                    onClick={() => setSourceFile(null)}
                    className="mt-4 text-[10px] underline uppercase font-bold hover:text-red-600"
                  >
                    Trocar Arquivo
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="mx-auto mb-4" size={48} />
                  <p className="text-sm font-bold uppercase tracking-widest">Arraste o CSV da Ecowitt aqui</p>
                  <p className="text-[10px] opacity-50 mt-2">O sistema ignorará a primeira linha de categorias automaticamente</p>
                  <input 
                    type="file" 
                    className="hidden" 
                    id="source-file" 
                    accept=".csv"
                    onChange={handleFileUpload}
                    ref={sourceInputRef}
                  />
                  <label htmlFor="source-file" className="mt-8 inline-block cursor-pointer bg-[#141414] text-white px-8 py-3 text-xs font-bold uppercase hover:bg-[#E4E3E0] hover:text-[#141414] transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,0.2)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px]">
                    Selecionar CSV
                  </label>
                </>
              )}
            </div>
          </Card>

          {processedData.length > 0 && (
            <Card title="2. Prévia dos Dados Convertidos">
              <div className="overflow-x-auto border border-[#141414]">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-[#141414] text-white uppercase">
                    <tr>
                      <th className="p-3 border-r border-white/20">Date</th>
                      <th className="p-3 border-r border-white/20">Rain (mm)</th>
                      <th className="p-3 border-r border-white/20">T Max</th>
                      <th className="p-3 border-r border-white/20">T Min</th>
                      <th className="p-3 border-r border-white/20">T Mean</th>
                      <th className="p-3">RH Mean</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processedData.slice(0, 10).map((row, i) => (
                      <tr key={i} className="border-b border-[#141414] hover:bg-[#E4E3E0]">
                        <td className="p-3 border-r border-[#141414]">{row.date}</td>
                        <td className="p-3 border-r border-[#141414]">{row.rain_mm}</td>
                        <td className="p-3 border-r border-[#141414]">{row.tmax_c}</td>
                        <td className="p-3 border-r border-[#141414]">{row.tmin_c}</td>
                        <td className="p-3 border-r border-[#141414]">{row.tmean_c}</td>
                        <td className="p-3">{row.rh_mean}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {processedData.length > 10 && (
                  <div className="p-3 text-center bg-[#F5F5F5] text-[10px] font-bold uppercase opacity-50">
                    Exibindo 10 de {processedData.length} linhas...
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        <aside className="lg:col-span-4 space-y-6">
          <Card title="Logs do Processo" className="h-[400px] flex flex-col">
            <div className="flex-1 font-mono text-[10px] space-y-2 overflow-y-auto pr-2 custom-scrollbar">
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center opacity-30 italic">
                  Aguardando arquivo...
                </div>
              ) : (
                logs.map((v) => (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={v.id} 
                    className={`p-2 border border-[#141414] flex flex-col gap-1 ${
                      v.type === 'warning' ? 'bg-yellow-50 border-yellow-200' : 
                      v.type === 'error' ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      {v.type === 'warning' ? <AlertTriangle size={12} className="text-yellow-600"/> : 
                       v.type === 'error' ? <X size={12} className="text-red-600"/> : 
                       <CheckCircle size={12} className="text-green-600"/>}
                      <span className="uppercase">{v.type}</span>
                      <span className="ml-auto opacity-40">{v.timestamp}</span>
                    </div>
                    <span className="leading-tight">{v.msg}</span>
                  </motion.div>
                ))
              )}
            </div>
          </Card>
          
          <div className="flex flex-col gap-4">
            <Button 
              variant="primary" 
              onClick={processEcowittData}
              disabled={status === 'processing' || !sourceFile}
            >
              {status === 'processing' ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  <span>CONVERTENDO...</span>
                </>
              ) : (
                <>
                  <Download size={18} />
                  <span>CONVERTER E BAIXAR</span>
                </>
              )}
            </Button>
            <Button variant="secondary" onClick={clearData}>
              <Trash2 size={18} />
              <span>LIMPAR</span>
            </Button>
          </div>

          <div className="bg-[#141414] text-white p-6 text-[10px] font-mono leading-relaxed border-l-4 border-yellow-400">
            <p className="font-bold mb-3 border-b border-white/20 pb-1 uppercase tracking-widest text-xs">Regras de Negócio</p>
            <ul className="space-y-2 opacity-80">
              <li>• Ignora 1ª linha (Categorias)</li>
              <li>• Agrupamento por Data (Time)</li>
              <li>• Rain: Máximo de Daily(mm)</li>
              <li>• Temp: Max, Min e Média</li>
              <li>• Humid: Média aritmética</li>
              <li>• Limpeza de caracteres especiais</li>
            </ul>
          </div>
        </aside>
      </main>

      <footer className="mt-20 text-[10px] uppercase tracking-widest opacity-50 border-t border-[#141414] pt-6 flex flex-col md:flex-row justify-between gap-4">
        <div className="flex gap-4">
          <span>ETL ENGINE v3.0</span>
          <span className="hidden md:inline">|</span>
          <span>PANDAS LOGIC EMULATION</span>
        </div>
        <div>
          © 2024 ECOWITT CONVERTER - BRUTALIST EDITION
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #F5F5F5;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #141414;
        }
      `}</style>
    </div>
  );
}
