import React from "react";
import { useDashboardUIStore } from "../_stores/useDashboardUiStore";
import { AlertCircle, Bell, CheckCircle2 } from "lucide-react";

export interface Notification {
  id: number;
  title: string;
  desc: string;
  time: string;
  isRead: boolean;
  type: "success" | "warning" | "info";
}
type Props = { notifs: Notification[] };

function Notifications({ notifs }: Props) {
  // اگر از هوک‌های جداگانه (که قبلاً صحبت کردیم) استفاده نمی‌کنید، همین روش خوب است
  const isNotifOpen = useDashboardUIStore((s) => s.isNotifOpen);
  const setIsNotifOpen = useDashboardUIStore((s) => s.setIsNotifOpen);

  return (
    <div className="relative">
      {/* دکمه زنگوله */}
      <button
        onClick={() => setIsNotifOpen(!isNotifOpen)}
        className="relative cursor-pointer p-2 rounded-full hover:bg-[var(--leaf-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <Bell size={20} />
        {/* نشانگر قرمز (Badge) */}
        <span className="absolute top-2 right-2 w-2 h-2 bg-[var(--error-color)] rounded-full animate-pulse shadow-sm"></span>
      </button>

      {/* لایه پس‌زمینه برای بستن منو با کلیک بیرون (Overlay) */}
      {/* این لایه فقط زمانی رندر می‌شود که منو باز باشد تا جلوی کلیک‌های صفحه را نگیرد */}
      {isNotifOpen && (
        <div
          className="fixed inset-0 z-30"
          onClick={() => setIsNotifOpen(false)}
        />
      )}

      {/* باکس اعلان‌ها */}
      <div
        className={`
          absolute left-0 top-full mt-2 w-72 sm:w-80 z-40 overflow-hidden
          glass-panel rounded-2xl shadow-xl shadow-[var(--accent-glow)]/20
          origin-top-left border border-[var(--card-border)]
          transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]
          ${
            isNotifOpen
              ? "transform scale-100 opacity-100 translate-y-0 visible"
              : "transform scale-90 opacity-0 -translate-y-2 invisible pointer-events-none"
          }
        `}
      >
        <div className="px-4 py-3 border-b border-[var(--card-border)] flex justify-between items-center bg-[var(--leaf-bg)]">
          <h3 className="font-bold text-sm text-[var(--text-primary)]">
            اعلان‌ها
          </h3>
          <span className="text-[10px] bg-[var(--accent-primary)] text-white px-2 py-0.5 rounded-full">
            3 جدید
          </span>
        </div>

        <div className="max-h-64 overflow-y-auto">
          {notifs.map((notif) => (
            <div
              key={notif.id}
              className={`px-4 py-3 border-b border-[var(--card-border)] last:border-0 hover:bg-[var(--bg-inner)] transition-colors ${
                !notif.isRead ? "bg-[var(--leaf-bg)]/30" : ""
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-1 p-1 rounded-full ${
                    notif.type === "success"
                      ? "text-green-500"
                      : notif.type === "warning"
                      ? "text-orange-500"
                      : "text-blue-500"
                  }`}
                >
                  {notif.type === "success" ? (
                    <CheckCircle2 size={16} />
                  ) : notif.type === "warning" ? (
                    <AlertCircle size={16} />
                  ) : (
                    <Bell size={16} />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {notif.title}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    {notif.desc}
                  </p>
                  <p className="text-[10px] text-[var(--text-secondary)] mt-1 opacity-70">
                    {notif.time}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="p-2 text-center border-t border-[var(--card-border)]">
          <button className="text-xs text-[var(--accent-primary)] hover:underline">
            مشاهده همه اعلان‌ها
          </button>
        </div>
      </div>
    </div>
  );
}

export default Notifications;
