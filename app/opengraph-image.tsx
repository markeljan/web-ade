import { ImageResponse } from 'next/og';

export const alt = 'Web ADE — Open-Source Web Agent Development Environment';

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = 'image/png';

const TECH_PILLS = [
  'Next.js 16',
  'AI SDK 7',
  'ui-sdk',
  'json-render',
  'wterm',
  'screen-relay',
  'libfx',
] as const;

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: '#111112',
        backgroundImage:
          'radial-gradient(circle at 86% 14%, rgba(34, 91, 255, 0.28) 0%, rgba(17, 17, 18, 0) 48%), radial-gradient(circle at 12% 92%, rgba(61, 135, 255, 0.16) 0%, rgba(17, 17, 18, 0) 44%)',
        padding: '44px',
        color: '#F2F4F6',
        fontFamily: 'sans-serif',
      }}
    >
      {/* Concentric Astryx surface container */}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: 'rgba(31, 31, 34, 0.72)',
          border: '1px solid rgba(242, 244, 246, 0.12)',
          borderRadius: '28px',
          padding: '48px 54px',
        }}
      >
        {/* Header Row: Brand Mark + Status Badge */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '18px',
            }}
          >
            <svg width="58" height="58" viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <rect
                x="2"
                y="2"
                width="60"
                height="60"
                rx="16"
                fill="#15161A"
                stroke="rgba(242, 244, 246, 0.16)"
                strokeWidth="1.5"
              />
              <rect
                x="8"
                y="8"
                width="48"
                height="48"
                rx="10"
                stroke="rgba(61, 135, 255, 0.2)"
                strokeWidth="1"
              />
              <path
                d="M18.5 46L30.25 18.2C30.92 16.6 33.08 16.6 33.75 18.2L45.5 46"
                stroke="#3D87FF"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect x="24.5" y="34.5" width="15" height="5" rx="2.5" fill="#E6EEFF" />
            </svg>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}
            >
              <span
                style={{
                  fontSize: '20px',
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: '#F2F4F6',
                }}
              >
                Web ADE
              </span>
              <span
                style={{
                  fontSize: '14px',
                  color: '#858D99',
                  letterSpacing: '0.04em',
                }}
              >
                WEB-ADE.COM · ASTRYX · VERCEL LABS
              </span>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 18px',
              borderRadius: '9999px',
              backgroundColor: 'rgba(61, 135, 255, 0.14)',
              border: '1px solid rgba(61, 135, 255, 0.32)',
              fontSize: '16px',
              fontWeight: 600,
              color: '#8BB8FF',
            }}
          >
            <div
              style={{
                width: '9px',
                height: '9px',
                borderRadius: '9999px',
                backgroundColor: '#3D87FF',
              }}
            />
            <span>Open-Source Starter</span>
          </div>
        </div>

        {/* Center Hero Typography */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            marginTop: '-8px',
          }}
        >
          <div
            style={{
              fontSize: '82px',
              fontWeight: 700,
              letterSpacing: '-0.045em',
              lineHeight: 1.02,
              color: '#F2F4F6',
            }}
          >
            Web ADE
          </div>
          <div
            style={{
              fontSize: '32px',
              fontWeight: 400,
              letterSpacing: '-0.015em',
              lineHeight: 1.3,
              color: '#A9B1BC',
              maxWidth: '940px',
            }}
          >
            Open-Source Web Agent Development Environment
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              marginTop: '4px',
              fontSize: '18px',
              color: '#858D99',
            }}
          >
            <span>Progressive Chat + Workbench</span>
            <span style={{ color: '#3D87FF' }}>•</span>
            <span>5-Tier Provider Waterfall</span>
            <span style={{ color: '#3D87FF' }}>•</span>
            <span>Dual-Tier Sandbox &amp; Live Browser</span>
          </div>
        </div>

        {/* Bottom Tech Pills Strip */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '1px',
              backgroundColor: 'rgba(242, 244, 246, 0.1)',
            }}
          />
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            {TECH_PILLS.map((pill, index) => (
              <div
                key={pill}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '9px 18px',
                    borderRadius: '9999px',
                    backgroundColor: index < 2 ? 'rgba(34, 91, 255, 0.2)' : '#18181B',
                    border:
                      index < 2
                        ? '1px solid rgba(61, 135, 255, 0.45)'
                        : '1px solid rgba(242, 244, 246, 0.14)',
                    color: index < 2 ? '#D9E8FF' : '#D5DCE4',
                    fontSize: '18px',
                    fontWeight: 500,
                  }}
                >
                  {pill}
                </div>
                {index < TECH_PILLS.length - 1 ? (
                  <span style={{ color: 'rgba(133, 141, 153, 0.65)', fontSize: '18px' }}>•</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    {
      ...size,
    },
  );
}
