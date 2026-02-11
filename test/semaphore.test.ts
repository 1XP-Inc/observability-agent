import { Semaphore } from "../src/semaphore";

describe("Semaphore", () => {
  // --- 생성자 검증 ---
  describe("constructor", () => {
    it("max > 0 이면 정상 생성된다", () => {
      const sem = new Semaphore(3);
      expect(sem.capacity()).toBe(3);
      expect(sem.current()).toBe(0);
    });

    it("max = 1 이면 정상 생성된다", () => {
      const sem = new Semaphore(1);
      expect(sem.capacity()).toBe(1);
    });

    it("max = 0 이면 에러를 던진다", () => {
      expect(() => new Semaphore(0)).toThrow("Semaphore max must be > 0 (got: 0)");
    });

    it("max 가 음수이면 에러를 던진다", () => {
      expect(() => new Semaphore(-1)).toThrow("Semaphore max must be > 0 (got: -1)");
    });

    it("max 가 NaN 이면 에러를 던진다", () => {
      expect(() => new Semaphore(NaN)).toThrow("Semaphore max must be > 0 (got: NaN)");
    });

    it("max 가 Infinity 이면 에러를 던진다", () => {
      expect(() => new Semaphore(Infinity)).toThrow(
        "Semaphore max must be > 0 (got: Infinity)",
      );
    });

    it("max 가 -Infinity 이면 에러를 던진다", () => {
      expect(() => new Semaphore(-Infinity)).toThrow(
        "Semaphore max must be > 0 (got: -Infinity)",
      );
    });
  });

  // --- tryAcquire ---
  describe("tryAcquire", () => {
    it("max 까지 true 를 반환한다", () => {
      const sem = new Semaphore(2);
      expect(sem.tryAcquire()).toBe(true);
      expect(sem.tryAcquire()).toBe(true);
    });

    it("max 를 초과하면 false 를 반환한다", () => {
      const sem = new Semaphore(2);
      sem.tryAcquire();
      sem.tryAcquire();
      expect(sem.tryAcquire()).toBe(false);
    });

    it("current() 가 acquire 할 때마다 증가한다", () => {
      const sem = new Semaphore(3);
      expect(sem.current()).toBe(0);
      sem.tryAcquire();
      expect(sem.current()).toBe(1);
      sem.tryAcquire();
      expect(sem.current()).toBe(2);
    });
  });

  // --- release ---
  describe("release", () => {
    it("release 하면 current 가 감소한다", () => {
      const sem = new Semaphore(2);
      sem.tryAcquire();
      sem.tryAcquire();
      expect(sem.current()).toBe(2);

      sem.release();
      expect(sem.current()).toBe(1);
    });

    it("release 후 다시 acquire 할 수 있다", () => {
      const sem = new Semaphore(1);
      expect(sem.tryAcquire()).toBe(true);
      expect(sem.tryAcquire()).toBe(false);

      sem.release();
      expect(sem.tryAcquire()).toBe(true);
    });

    it("inUse=0 일 때 release 해도 0 이하로 내려가지 않는다", () => {
      const sem = new Semaphore(2);
      // 아무것도 acquire 하지 않은 상태에서 release
      sem.release();
      expect(sem.current()).toBe(0);

      // acquire 1개 후 release 2번
      sem.tryAcquire();
      sem.release();
      sem.release();
      expect(sem.current()).toBe(0);
    });
  });

  // --- capacity ---
  describe("capacity", () => {
    it("생성 시 설정한 max 를 반환한다", () => {
      const sem = new Semaphore(5);
      expect(sem.capacity()).toBe(5);

      // acquire/release 와 무관하게 capacity 는 변하지 않는다
      sem.tryAcquire();
      expect(sem.capacity()).toBe(5);
      sem.release();
      expect(sem.capacity()).toBe(5);
    });
  });
});
