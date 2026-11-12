// @ts-nocheck
/**
 * 千禧年桌宠控制器
 * 实现全屏飞行、鼠标跟随、苍蝇路径（Perlin噪声）、双击受击等行为
 */

import { ANIMATIONS, selectAnimation, getHitAnimation, type Animation } from './pet-animations.ts';

/** Perlin 噪声生成器（简化版，用于苍蝇路径） */
class SimplexNoise {
  private perm: number[];

  constructor(seed = Date.now()) {
    this.perm = [];
    for (let i = 0; i < 256; i++) this.perm[i] = i;
    // Fisher-Yates 洗牌
    let rng = seed;
    for (let i = 255; i > 0; i--) {
      rng = (rng * 9301 + 49297) % 233280;
      const j = Math.floor((rng / 233280) * (i + 1));
      [this.perm[i], this.perm[j]] = [this.perm[j], this.perm[i]];
    }
    // 扩展到 512
    for (let i = 0; i < 256; i++) this.perm[256 + i] = this.perm[i];
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  private grad(hash: number, x: number, y: number): number {
    const h = hash & 3;
    const u = h < 2 ? x : y;
    const v = h < 2 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  /** 2D Perlin 噪声，返回 [-1, 1] */
  noise2D(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = this.fade(x);
    const v = this.fade(y);
    const a = this.perm[X] + Y;
    const b = this.perm[X + 1] + Y;
    return this.lerp(
      v,
      this.lerp(u, this.grad(this.perm[a], x, y), this.grad(this.perm[b], x - 1, y)),
      this.lerp(u, this.grad(this.perm[a + 1], x, y - 1), this.grad(this.perm[b + 1], x - 1, y - 1))
    );
  }
}

export interface PetState {
  /** 当前位置 */
  x: number;
  y: number;
  /** 速度 */
  vx: number;
  vy: number;
  /** 当前动画ID */
  animation: string;
  /** 当前帧索引 */
  frameIndex: number;
  /** 帧计时器 */
  frameTick: number;
  /** 行为模式 */
  mode: 'idle' | 'follow' | 'wander';
  /** 苍蝇路径目标点 */
  targetX: number;
  targetY: number;
  /** 是否正在播放受击动画 */
  isHit: boolean;
}

export interface PetConfig {
  /** 屏幕宽度 */
  screenWidth: number;
  /** 屏幕高度 */
  screenHeight: number;
  /** 桌宠尺寸 */
  size: number;
  /** 移动速度 */
  speed: number;
  /** 鼠标跟随触发距离 */
  followDistance: number;
  /** 鼠标跟随失效距离 */
  followLoseDistance: number;
  /** 苍蝇路径噪声频率 */
  noiseFrequency: number;
  /** 苍蝇路径噪声幅度 */
  noiseAmplitude: number;
}

export class PetController {
  private state: PetState;
  private config: PetConfig;
  private noise: SimplexNoise;
  private noiseTime: number = 0;
  private mouseX: number = 0;
  private mouseY: number = 0;
  private lastUpdateTime: number = 0;

  constructor(config: Partial<PetConfig> = {}) {
    this.config = {
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      size: 180,
      speed: 2.5,
      followDistance: 300,
      followLoseDistance: 500,
      noiseFrequency: 0.002,
      noiseAmplitude: 150,
      ...config,
    };

    this.state = {
      x: this.config.screenWidth / 2,
      y: this.config.screenHeight / 2,
      vx: 0,
      vy: 0,
      animation: 'idle_front',
      frameIndex: 0,
      frameTick: 0,
      mode: 'wander',
      targetX: this.config.screenWidth / 2,
      targetY: this.config.screenHeight / 2,
      isHit: false,
    };

    this.noise = new SimplexNoise();
    this.lastUpdateTime = Date.now();
  }

  /** 更新鼠标位置 */
  updateMousePosition(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  /** 更新屏幕尺寸 */
  updateScreenSize(width: number, height: number): void {
    this.config.screenWidth = width;
    this.config.screenHeight = height;
  }

  /** 触发受击动画 */
  triggerHit(): void {
    if (this.state.isHit) return;
    this.state.isHit = true;
    this.state.animation = getHitAnimation();
    this.state.frameIndex = 0;
    this.state.frameTick = 0;

    // 受击震动效果
    const shakeX = (Math.random() - 0.5) * 20;
    const shakeY = (Math.random() - 0.5) * 20;
    this.state.x += shakeX;
    this.state.y += shakeY;

    // 800ms 后恢复
    setTimeout(() => {
      this.state.isHit = false;
      this.state.animation = 'idle_front';
    }, 800);
  }

  /** 主更新循环 */
  update(deltaTime: number): void {
    if (this.state.isHit) {
      // 受击状态不移动，只更新动画
      this.updateAnimation(deltaTime);
      return;
    }

    // 更新行为模式
    this.updateMode();

    // 更新目标点
    this.updateTarget(deltaTime);

    // 更新速度
    this.updateVelocity();

    // 更新位置
    this.updatePosition(deltaTime);

    // 边界检测
    this.clampPosition();

    // 更新动画
    this.updateAnimation(deltaTime);
  }

  private updateMode(): void {
    const distToMouse = Math.hypot(this.mouseX - this.state.x, this.mouseY - this.state.y);

    if (distToMouse < this.config.followDistance) {
      this.state.mode = 'follow';
    } else if (distToMouse > this.config.followLoseDistance && this.state.mode === 'follow') {
      this.state.mode = 'wander';
    }
  }

  private updateTarget(deltaTime: number): void {
    if (this.state.mode === 'follow') {
      // 鼠标跟随模式：目标是鼠标位置
      this.state.targetX = this.mouseX;
      this.state.targetY = this.mouseY;
    } else {
      // 苍蝇路径模式：使用 Perlin 噪声生成目标点
      this.noiseTime += deltaTime * this.config.noiseFrequency;

      const noiseX = this.noise.noise2D(this.noiseTime, 0) * this.config.noiseAmplitude;
      const noiseY = this.noise.noise2D(0, this.noiseTime) * this.config.noiseAmplitude;

      const centerX = this.config.screenWidth / 2;
      const centerY = this.config.screenHeight / 2;

      this.state.targetX = centerX + noiseX;
      this.state.targetY = centerY + noiseY;

      // 限制在屏幕范围内
      this.state.targetX = Math.max(
        this.config.size / 2,
        Math.min(this.config.screenWidth - this.config.size / 2, this.state.targetX)
      );
      this.state.targetY = Math.max(
        this.config.size / 2,
        Math.min(this.config.screenHeight - this.config.size / 2, this.state.targetY)
      );
    }
  }

  private updateVelocity(): void {
    const dx = this.state.targetX - this.state.x;
    const dy = this.state.targetY - this.state.y;
    const dist = Math.hypot(dx, dy);

    if (dist > 5) {
      // 归一化方向并乘以速度
      this.state.vx = (dx / dist) * this.config.speed;
      this.state.vy = (dy / dist) * this.config.speed;
    } else {
      // 已到达目标，减速
      this.state.vx *= 0.9;
      this.state.vy *= 0.9;
    }
  }

  private updatePosition(deltaTime: number): void {
    this.state.x += this.state.vx;
    this.state.y += this.state.vy;
  }

  private clampPosition(): void {
    const half = this.config.size / 2;
    this.state.x = Math.max(half, Math.min(this.config.screenWidth - half, this.state.x));
    this.state.y = Math.max(half, Math.min(this.config.screenHeight - half, this.state.y));
  }

  private updateAnimation(deltaTime: number): void {
    const isMoving = Math.abs(this.state.vx) > 0.5 || Math.abs(this.state.vy) > 0.5;

    // 选择动画
    if (!this.state.isHit) {
      const newAnim = selectAnimation({ x: this.state.vx, y: this.state.vy }, isMoving);
      if (newAnim !== this.state.animation) {
        this.state.animation = newAnim;
        this.state.frameIndex = 0;
        this.state.frameTick = 0;
      }
    }

    // 更新帧
    const anim = ANIMATIONS[this.state.animation];
    if (!anim) return;

    const currentFrame = anim.frames[this.state.frameIndex];
    const frameDuration = currentFrame?.duration ?? anim.frameDuration;

    this.state.frameTick += deltaTime;
    if (this.state.frameTick >= frameDuration) {
      this.state.frameTick = 0;
      this.state.frameIndex++;

      if (this.state.frameIndex >= anim.frames.length) {
        if (anim.loop) {
          this.state.frameIndex = 0;
        } else {
          // 不循环的动画（如受击）播放完后切换到下一个
          this.state.frameIndex = anim.frames.length - 1;
          if (anim.nextAnimation) {
            this.state.animation = anim.nextAnimation;
            this.state.frameIndex = 0;
          }
        }
      }
    }
  }

  /** 获取当前状态（供渲染使用） */
  getState(): Readonly<PetState> {
    return this.state;
  }

  /** 获取当前帧的完整信息（包括身体、翅膀、偏移） */
  getCurrentFrame(): AnimationFrame | null {
    const anim = ANIMATIONS[this.state.animation];
    if (!anim) return null;
    return anim.frames[this.state.frameIndex] || null;
  }

  /** 获取当前帧的素材ID（兼容旧版本） */
  getCurrentFrameId(): string {
    const frame = this.getCurrentFrame();
    return frame?.body ?? '正面_Y';
  }

  /** 获取配置 */
  getConfig(): Readonly<PetConfig> {
    return this.config;
  }

  /** 设置配置 */
  setConfig(config: Partial<PetConfig>): void {
    Object.assign(this.config, config);
  }
}
