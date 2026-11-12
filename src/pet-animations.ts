/**
 * 千禧年桌宠动画配置
 * 定义所有动画序列、帧率和切换规则
 * 支持身体+翅膀分层渲染
 */

export interface AnimationFrame {
  /** 身体图层ID（对应 assets/pet/ 下的文件名，不含 .png） */
  body: string;
  /** 翅膀图层ID列表（可选，支持多层翅膀叠加） */
  wings?: string[];
  /** 可选：该帧的持续时间（毫秒），覆盖动画默认值 */
  duration?: number;
  /** 可选：身体Y轴偏移（像素），用于上下浮动效果 */
  offsetY?: number;
}

export interface Animation {
  /** 动画ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 帧序列 */
  frames: AnimationFrame[];
  /** 默认帧间隔（毫秒） */
  frameDuration: number;
  /** 是否循环播放 */
  loop: boolean;
  /** 播放完成后的回调动画ID（不循环时有效） */
  nextAnimation?: string;
}

/**
 * 所有动画定义
 * 素材来自 Y 文件夹，已镜像生成向右后退系列
 * 支持身体+翅膀分层渲染，翅膀扇动模拟飞行
 */
export const ANIMATIONS: Record<string, Animation> = {
  // 待机动画 - 正面（翅膀轻微扇动 + 身体上下浮动）
  idle_front: {
    id: 'idle_front',
    name: '正面待机',
    frames: [
      { body: '正面_Y', wings: ['正面_翅膀1'], offsetY: 0 },
      { body: '正面_Y', wings: ['正面_翅膀2'], offsetY: -2 },
      { body: '正面_Y', wings: ['正面_翅膀1'], offsetY: -4 },
      { body: '正面_Y', wings: ['正面_翅膀2'], offsetY: -2 },
    ],
    frameDuration: 200,
    loop: true,
  },

  // 待机动画 - 背面
  idle_back: {
    id: 'idle_back',
    name: '背面待机',
    frames: [
      { body: '背面_Y', wings: ['背面_翅膀1'], offsetY: 0 },
      { body: '背面_Y', wings: ['背面_右翅膀'], offsetY: -2 },
      { body: '背面_Y', wings: ['背面_翅膀1'], offsetY: -4 },
      { body: '背面_Y', wings: ['背面_右翅膀'], offsetY: -2 },
    ],
    frameDuration: 200,
    loop: true,
  },

  // 向左移动（快速扇翅 + 明显浮动）
  walk_left: {
    id: 'walk_left',
    name: '向左飞行',
    frames: [
      { body: '向左移动_Y', wings: ['向左移动_翅膀1'], offsetY: 0 },
      { body: '向左移动_Y', wings: ['向左移动_翅膀2'], offsetY: -3 },
      { body: '向左移动_Y', wings: ['向左移动_翅膀1'], offsetY: -6 },
      { body: '向左移动_Y', wings: ['向左移动_翅膀2'], offsetY: -3 },
    ],
    frameDuration: 100,
    loop: true,
  },

  // 向右移动（镜像，需要前端水平翻转）
  walk_right: {
    id: 'walk_right',
    name: '向右飞行',
    frames: [
      { body: '向左移动_Y', wings: ['向右移动_翅膀2'], offsetY: 0 },
      { body: '向左移动_Y', wings: ['向右移动_翅膀2'], offsetY: -3 },
      { body: '向左移动_Y', wings: ['向右移动_翅膀2'], offsetY: -6 },
      { body: '向左移动_Y', wings: ['向右移动_翅膀2'], offsetY: -3 },
    ],
    frameDuration: 100,
    loop: true,
  },

  // 向左后退
  walk_leftback: {
    id: 'walk_leftback',
    name: '向左后退',
    frames: [
      { body: 'Y_向左后退', wings: ['向左后退_翅膀'], offsetY: 0 },
      { body: 'Y_向左后退', wings: ['向左后退_翅膀2'], offsetY: -2 },
      { body: 'Y_向左后退', wings: ['向左后退_翅膀'], offsetY: -4 },
      { body: 'Y_向左后退', wings: ['向左后退_翅膀2'], offsetY: -2 },
    ],
    frameDuration: 120,
    loop: true,
  },

  // 向右后退（已镜像生成）
  walk_rightback: {
    id: 'walk_rightback',
    name: '向右后退',
    frames: [
      { body: 'Y_向右后退', wings: ['向右后退_翅膀'], offsetY: 0 },
      { body: 'Y_向右后退', wings: ['向右后退_翅膀2'], offsetY: -2 },
      { body: 'Y_向右后退', wings: ['向右后退_翅膀'], offsetY: -4 },
      { body: 'Y_向右后退', wings: ['向右后退_翅膀2'], offsetY: -2 },
    ],
    frameDuration: 120,
    loop: true,
  },

  // 受击动画 - 白色闪烁（无翅膀，整体受击）
  hit_white: {
    id: 'hit_white',
    name: '受击（白）',
    frames: [
      { body: 'Y向左后退_受击_白', duration: 80 },
      { body: 'Y_向左后退', duration: 80 },
      { body: 'Y向左后退_受击_白', duration: 80 },
      { body: 'Y_向左后退', duration: 80 },
    ],
    frameDuration: 80,
    loop: false,
    nextAnimation: 'idle_front',
  },

  // 受击动画 - 红色闪烁
  hit_red: {
    id: 'hit_red',
    name: '受击（红）',
    frames: [
      { body: 'Y向左后退_受击_红', duration: 80 },
      { body: 'Y_向左后退', duration: 80 },
      { body: 'Y向左后退_受击_红', duration: 80 },
      { body: 'Y_向左后退', duration: 80 },
    ],
    frameDuration: 80,
    loop: false,
    nextAnimation: 'idle_front',
  },

  // 受击动画 - 红边白身
  hit_mixed: {
    id: 'hit_mixed',
    name: '受击（混合）',
    frames: [
      { body: 'Y向左后退_受击_白身红边', duration: 80 },
      { body: 'Y_向左后退', duration: 80 },
      { body: 'Y向左后退_受击_白身红边', duration: 80 },
      { body: 'Y_向左后退', duration: 80 },
    ],
    frameDuration: 80,
    loop: false,
    nextAnimation: 'idle_front',
  },
};

/**
 * 动画状态机
 * 根据移动方向选择对应动画
 */
export function selectAnimation(
  velocity: { x: number; y: number },
  isMoving: boolean
): string {
  if (!isMoving) {
    // 待机状态，根据上次朝向决定
    return 'idle_front';
  }

  const { x, y } = velocity;
  const absX = Math.abs(x);
  const absY = Math.abs(y);

  // 主要判断水平方向
  if (absX > absY * 0.5) {
    if (x < 0) {
      // 向左
      return y < 0 ? 'walk_leftback' : 'walk_left';
    } else {
      // 向右
      return y < 0 ? 'walk_rightback' : 'walk_right';
    }
  }

  // 垂直移动时显示正面或背面
  return y < 0 ? 'idle_back' : 'idle_front';
}

/**
 * 受击动画随机选择
 */
export function getHitAnimation(): string {
  const hits = ['hit_white', 'hit_red', 'hit_mixed'];
  return hits[Math.floor(Math.random() * hits.length)];
}
