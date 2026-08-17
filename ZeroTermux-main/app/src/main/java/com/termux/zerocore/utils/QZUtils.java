package com.termux.zerocore.utils;

import android.util.Log;
import android.widget.Toast;

import com.example.xh_lib.utils.UUtils;
import com.termux.zerocore.activity.utils.CreateSystemUtils;
import com.termux.zerocore.dialog.MyDialog;
import com.termux.zerocore.fragment.RestoreFragment;

import java.io.File;



public class QZUtils {

    private File mFile = new File("/data/data/com.termux/");
    private File createFile;

    public void main(MyDialog myDialog, String systemName, File tarFle, RestoreFragment restoreFragment) {

        new Thread(new Runnable() {
            @Override
            public void run() {

                Log.e("系统:", "run: " + tarFle.getName());

                try {
                    Thread.sleep(1000);
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }

                UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        myDialog.getDialog_pro().setText("系统搜索完成!");
                        myDialog.getDialog_pro_prog().setProgress(15);
                    }
                });

                //搜索系统


                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }


                UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        myDialog.getDialog_pro().setText("开始创建新的系统盘!");
                        myDialog.getDialog_pro_prog().setProgress(25);
                    }
                });


             /*   UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        com.termux.zerocore.utils.SingletonCommunicationUtils.getInstance().getmSingletonCommunicationListener().sendTextToTerminal("termux-setup-storage \n");
                    }
                });*/

                if (!(new File("/data/data/com.termux/files/home/storage").exists())) {


                    UUtils.getHandler().post(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(UUtils.getContext(), "没有找到storage目录,请手动创建", Toast.LENGTH_SHORT).show();

                            myDialog.dismiss();
                            com.termux.zerocore.utils.SingletonCommunicationUtils.getInstance().getmSingletonCommunicationListener().sendTextToTerminal("termux-setup-storage");
                            restoreFragment.getActivity().finish();
                        }
                    });
                    return;
                }

                //创建新的系统盘
                createSystem(systemName);

                if (createFile == null) {
                    UUtils.getHandler().post(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(UUtils.getContext(), "系统盘创建失败,请使用全手动模式恢复", Toast.LENGTH_SHORT).show();
                        }
                    });
                }

                Log.e("系统:", "run: " + createFile.getAbsolutePath());

                try {
                    Thread.sleep(1500);
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }

                UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        myDialog.getDialog_pro().setText("新的系统盘创建完成!");
                        myDialog.getDialog_pro_prog().setProgress(45);
                    }
                });

                try {
                    Thread.sleep(1500);
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }

                UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        myDialog.getDialog_pro().setText("处理最后的一些事请!");
                        myDialog.getDialog_pro_prog().setProgress(75);
                    }
                });


                try {
                    Thread.sleep(1000);
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }

                UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        myDialog.getDialog_pro().setText("3秒后开始恢复!");
                        myDialog.getDialog_pro_prog().setProgress(100);
                    }
                });


                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    e.printStackTrace();
                }

                UUtils.getHandler().post(new Runnable() {
                    @Override
                    public void run() {
                        myDialog.dismiss();
                        Toast.makeText(UUtils.getContext(), "开始恢复..", Toast.LENGTH_SHORT).show();

                        com.termux.zerocore.utils.SingletonCommunicationUtils.getInstance().getmSingletonCommunicationListener().sendTextToTerminal("echo \"----手动恢复开始----\" \n");

                        com.termux.zerocore.utils.SingletonCommunicationUtils.getInstance().getmSingletonCommunicationListener().sendTextToTerminal(
                            com.termux.zerocore.data.CommendShellData.getShellRestore(
                                com.termux.zerocore.data.CommendShellData.SHELL_TAR_RESTORE_GZ,
                                tarFle,
                                createFile));
                        //com.termux.zerocore.utils.SingletonCommunicationUtils.getInstance().getmSingletonCommunicationListener().sendTextToTerminal("tar -xzvf./storage/shared/xinhao/data/" + tarFle.getName() + "  -C ../../" + createFile.getName() + " && mv ../../" + createFile.getName() + "/data/data/com.termux/files/home ../../" + createFile.getName() +" && "+ "mv ../../" + createFile.getName() + "/data/data/com.termux/files/usr ../../" + createFile.getName()+" && rm -rf ../../"+createFile.getName()+"/data && echo \"系统恢复完成,请在切换系统，切换您的系统\" \n");

                        try {
                            restoreFragment.getActivity().finish();
                        }catch (Exception e){
                            Toast.makeText(UUtils.getContext(), "出现了一个微弱的警告，可忽略", Toast.LENGTH_SHORT).show();
                        }
                    }
                });

            }
        }).start();

    }


    //创建
    private void createSystem(String name) {
        createFile = CreateSystemUtils.createContainerReturningDir(name);
    }
}
