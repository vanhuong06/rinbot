/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Bot, ShoppingCart, Bell, Settings, Activity, Trash2, Power } from 'lucide-react';
import { motion } from 'framer-motion';

interface Stat {
  count: number;
  status: string;
}

export default function App() {
  const [stats, setStats] = useState<Stat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, []);

  const [apiData, setApiData] = useState<any[]>([]);
  const [fetchingApi, setFetchingApi] = useState(false);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) {
        const text = await res.text();
        console.error(`Stats API returned ${res.status}: ${text.substring(0, 100)}`);
        return;
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Expected JSON, got HTML. Server might be restarting.");
        return;
      }
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch stats', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchApiData = async () => {
    setFetchingApi(true);
    try {
      const res = await fetch('/api/external-list');
      if (!res.ok) {
        const text = await res.text();
        console.error(`External API returned ${res.status}: ${text.substring(0, 100)}`);
        return;
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Expected JSON, got HTML. Server might be restarting.");
        return;
      }
      const data = await res.json();
      setApiData(Array.isArray(data) ? data : (data.data || []));
    } catch (err) {
      console.error('Failed to fetch API data', err);
    } finally {
      setFetchingApi(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f5f0] text-[#1a1a1a] font-sans p-6 md:p-12">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between mb-12">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-[#5A5A40] rounded-full flex items-center justify-center text-white">
              <Bot size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-serif font-medium">Quản trị Bot Mua Sắm</h1>
              <p className="text-sm text-[#5A5A40]/60 italic">Bảng điều khiển Giám sát & Tự động hóa</p>
            </div>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-full border border-[#5A5A40]/10 shadow-sm">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-xs font-medium uppercase tracking-wider">Bot đang hoạt động</span>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <StatCard 
            icon={<Activity size={20} />} 
            label="Đang giám sát" 
            value={stats.find(s => s.status === 'monitoring')?.count || 0} 
            color="bg-blue-50 text-blue-600"
          />
          <StatCard 
            icon={<Bell size={20} />} 
            label="Có hàng" 
            value={stats.find(s => s.status === 'available')?.count || 0} 
            color="bg-amber-50 text-amber-600"
          />
          <StatCard 
            icon={<ShoppingCart size={20} />} 
            label="Đã mua" 
            value={stats.find(s => s.status === 'purchased')?.count || 0} 
            color="bg-emerald-50 text-emerald-600"
          />
        </div>

        {/* Live API Data */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-3xl p-8 shadow-sm border border-[#5A5A40]/5 mb-12"
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-serif flex items-center gap-2">
              <Activity size={20} className="text-[#5A5A40]" />
              Dữ liệu API Trực tiếp
            </h2>
            <button 
              onClick={fetchApiData}
              disabled={fetchingApi}
              className="px-4 py-2 bg-[#5A5A40] text-white rounded-xl text-xs font-medium hover:bg-[#4a4a35] transition-colors disabled:opacity-50"
            >
              {fetchingApi ? 'Đang tải...' : 'Làm mới danh sách API'}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[#f5f5f0]">
                  <th className="pb-3 font-semibold text-[#5A5A40]/40 uppercase tracking-wider text-[10px]">ID</th>
                  <th className="pb-3 font-semibold text-[#5A5A40]/40 uppercase tracking-wider text-[10px]">Tên sản phẩm</th>
                  <th className="pb-3 font-semibold text-[#5A5A40]/40 uppercase tracking-wider text-[10px]">Giá</th>
                  <th className="pb-3 font-semibold text-[#5A5A40]/40 uppercase tracking-wider text-[10px]">Hành động</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f5f5f0]">
                {apiData.length > 0 ? apiData.slice(0, 5).map((item) => (
                  <tr key={item.id}>
                    <td className="py-4 font-mono text-xs">{item.id}</td>
                    <td className="py-4 font-medium">{item.name || item.title || item.resource_name || 'N/A'}</td>
                    <td className="py-4 text-[#5A5A40]/60">{item.price || item.amount || 'N/A'}</td>
                    <td className="py-4">
                      <button className="text-[#5A5A40] hover:underline text-xs">Sao chép ID</button>
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-[#5A5A40]/30 italic">Chưa có dữ liệu. Nhấn làm mới để xem danh sách sản phẩm.</td>
                  </tr>
                )}
              </tbody>
            </table>
            {apiData.length > 5 && (
              <p className="mt-4 text-[10px] text-[#5A5A40]/40 text-center">Đang hiển thị 5 trên {apiData.length} sản phẩm</p>
            )}
          </div>
        </motion.div>

        {/* Instructions */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-3xl p-8 shadow-sm border border-[#5A5A40]/5"
        >
          <h2 className="text-xl font-serif mb-6 flex items-center gap-2">
            <Settings size={20} className="text-[#5A5A40]" />
            Hướng dẫn sử dụng Bot
          </h2>
          
          <div className="space-y-6">
            <Step 
              number="01" 
              title="Kết nối Telegram" 
              description="Mở Telegram và tìm kiếm bot của bạn. Sử dụng lệnh /start để bắt đầu."
            />
            <Step 
              number="02" 
              title="Thêm sản phẩm" 
              description="Gửi /monitor <product_id> cho bot. Bot sẽ lấy thông tin sản phẩm và bắt đầu giám sát."
            />
            <Step 
              number="03" 
              title="Bật Tự động mua" 
              description="Sử dụng /autobuy <id> 1 để cho phép bot tự động mua khi có hàng."
            />
          </div>

          <div className="mt-12 pt-8 border-t border-[#f5f5f0]">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-[#5A5A40]/40 mb-4">Lệnh của Bot</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CommandItem cmd="/api_list" desc="Danh sách sản phẩm API" />
              <CommandItem cmd="/check <id>" desc="Kiểm tra kho nhanh" />
              <CommandItem cmd="/azeem" desc="Kiểm tra kho Azeem" />
              <CommandItem cmd="/auto_setup" desc="Thêm ID Azeem vào danh sách" />
              <CommandItem cmd="/get <id>" desc="Xem JSON gốc từ API" />
              <CommandItem cmd="/buy <id> <qty>" desc="Mua tài khoản" />
              <CommandItem cmd="/monitor <id>" desc="Theo dõi sản phẩm theo ID" />
              <CommandItem cmd="/list" desc="Danh sách đang theo dõi" />
              <CommandItem cmd="/scan" desc="Quét thủ công tất cả" />
              <CommandItem cmd="/stop <id>" desc="Dừng theo dõi sản phẩm" />
              <CommandItem cmd="/autobuy <id> <1|0>" desc="Bật/tắt tự động mua" />
            </div>
          </div>
        </motion.div>

        <footer className="mt-12 text-center text-[#5A5A40]/40 text-xs">
          <p>© 2026 Shopping Bot Engine • Tự động hóa tinh gọn</p>
        </footer>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: number, color: string }) {
  return (
    <div className="bg-white p-6 rounded-3xl shadow-sm border border-[#5A5A40]/5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-[#5A5A40]/40">{label}</p>
        <p className="text-2xl font-serif font-medium">{value}</p>
      </div>
    </div>
  );
}

function Step({ number, title, description }: { number: string, title: string, description: string }) {
  return (
    <div className="flex gap-6">
      <span className="text-4xl font-serif font-black text-[#5A5A40]/10 leading-none">{number}</span>
      <div>
        <h4 className="font-medium mb-1">{title}</h4>
        <p className="text-sm text-[#5A5A40]/60 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

function CommandItem({ cmd, desc }: { cmd: string, desc: string }) {
  return (
    <div className="flex items-center justify-between p-3 bg-[#f5f5f0] rounded-xl">
      <code className="text-xs font-mono font-bold text-[#5A5A40]">{cmd}</code>
      <span className="text-[10px] uppercase tracking-wider text-[#5A5A40]/50">{desc}</span>
    </div>
  );
}
