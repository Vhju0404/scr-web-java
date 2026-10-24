import org.objectweb.asm.ClassAdapter;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodAdapter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * Vá lỗi đơ game Ngọc Rồng Online 2.5.0 khi bấm "Cấu hình" ở màn hình đăng nhập.
 *
 * Menu "cau hinh" có 3 mục aw.y, aw.z, aw.A nhưng bảng chữ tiếng Việt (aw.<clinit>)
 * quên gán aw.A (chỉ bản tiếng Indonesia gán) -> game vẽ chuỗi null -> NullPointerException
 * làm chết luồng chính của game. Công cụ này thêm aw.A = "Sửa lỗi" vào cuối aw.<clinit>.
 *
 * Dùng: java -cp emulator/freej2me-headless.jar:tools PatchNroConfigMenu <aw.class vào> <aw.class ra>
 */
public class PatchNroConfigMenu {
  public static void main(String[] args) throws Exception {
    byte[] in = readAll(new FileInputStream(args[0]));
    ClassReader reader = new ClassReader(in);
    ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);

    reader.accept(new ClassAdapter(writer) {
      @Override
      public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
        MethodVisitor mv = super.visitMethod(access, name, desc, sig, ex);
        if (!"<clinit>".equals(name)) return mv;
        return new MethodAdapter(mv) {
          @Override
          public void visitInsn(int opcode) {
            if (opcode == Opcodes.RETURN) {
              super.visitLdcInsn("Sửa lỗi");
              super.visitFieldInsn(Opcodes.PUTSTATIC, "aw", "A", "Ljava/lang/String;");
            }
            super.visitInsn(opcode);
          }
        };
      }
    }, 0);

    FileOutputStream out = new FileOutputStream(args[1]);
    out.write(writer.toByteArray());
    out.close();
    System.out.println("Patched " + args[1]);
  }

  private static byte[] readAll(InputStream is) throws Exception {
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
    is.close();
    return bos.toByteArray();
  }
}
