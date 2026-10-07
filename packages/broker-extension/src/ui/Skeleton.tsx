import type { CSSProperties } from "react";

/** 한 줄 막대. width는 CSS 길이(기본 100%). */
export function SkeletonBar({ width = "100%", height = 12 }: { width?: string; height?: number }) {
  const style: CSSProperties = { width, height };
  return <div className="skeleton-block" style={style} aria-hidden="true" />;
}

/** 카드 모양 블록(막대 여러 개를 감싼다). */
export function SkeletonCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      {children}
    </div>
  );
}

/** 불러오는 중 컨테이너 — 스크린리더에는 "불러오는 중"만 읽힌다. */
export function SkeletonRegion({ children }: { children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output>은 스켈레톤 컨테이너로 부적합
    <div className="skeleton-region" role="status" aria-busy="true">
      <span className="sr-only">불러오는 중</span>
      {children}
    </div>
  );
}

/** 홈 탭 모양(남은 한도 카드 + 목록 카드). */
export function HomeSkeleton() {
  return (
    <SkeletonRegion>
      <SkeletonCard>
        <SkeletonBar width="30%" />
        <SkeletonBar height={20} width="60%" />
        <SkeletonBar />
        <SkeletonBar width="85%" />
      </SkeletonCard>
      <SkeletonCard>
        <SkeletonBar width="25%" />
        {[0, 1, 2].map((i) => (
          <SkeletonBar key={i} height={36} />
        ))}
      </SkeletonCard>
    </SkeletonRegion>
  );
}

/** 어시스턴트 탭 모양(메시지 막대 + 입력창 블록). */
export function AssistantSkeleton() {
  return (
    <SkeletonRegion>
      <SkeletonBar width="70%" height={40} />
      <SkeletonBar width="50%" height={40} />
      <SkeletonBar width="80%" height={40} />
      <SkeletonBar height={56} />
    </SkeletonRegion>
  );
}
