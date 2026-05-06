import Phaser from 'phaser';
import { GRAVITY_Y } from '../constants';
import { BootScene } from '../scenes/BootScene';
import { PreloadScene } from '../scenes/PreloadScene';
import { GameScene } from '../scenes/GameScene';

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1d1d1d',
  pixelArt: true,
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: GRAVITY_Y },
      debug: false
    }
  },
  // RESIZE mode locks the canvas to the parent #game element (which is 100vw x
  // 100vh), so the game fills the browser viewport. Camera zoom in GameScene
  // controls how zoomed-in the world appears, decoupled from window size.
  scale: {
    mode: Phaser.Scale.RESIZE,
    parent: 'game'
  },
  scene: [BootScene, PreloadScene, GameScene]
};
